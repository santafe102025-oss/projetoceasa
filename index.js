require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs"); // <- substitui bcrypt por bcryptjs
const { createClient } = require("@supabase/supabase-js");
const Database = require("better-sqlite3"); // <- substitui sqlite3 por better-sqlite3
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Conexão com banco SQLite
const db = new Database("database.db");

// Criação das tabelas (se não existirem)
db.prepare(`CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  cnpj TEXT NOT NULL UNIQUE,
  box TEXT,
  email TEXT NOT NULL UNIQUE,
  senha TEXT NOT NULL
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS arquivos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL,
  nome TEXT NOT NULL,
  caminho TEXT NOT NULL,
  data_upload DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas (id)
)`).run();

// Configuração Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Middlewares
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: "segredo",
    resave: false,
    saveUninitialized: true,
  })
);

// Middleware de autenticação
function authMiddleware(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login.html");
  }
  next();
}

// Rotas
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Cadastro de empresa
app.post("/cadastro", async (req, res) => {
  const { nome, cnpj, box, email, senha } = req.body;
  try {
    const hash = await bcrypt.hash(senha, 10);
    db.prepare("INSERT INTO empresas (nome, cnpj, box, email, senha) VALUES (?, ?, ?, ?, ?)")
      .run(nome, cnpj, box, email, hash);
    res.redirect("/login.html");
  } catch (err) {
    console.error("Erro no cadastro:", err.message);
    res.status(500).send("Erro ao cadastrar empresa.");
  }
});

// Login
app.post("/login", async (req, res) => {
  const { email, senha } = req.body;
  try {
    const empresa = db.prepare("SELECT * FROM empresas WHERE email = ?").get(email);
    if (empresa && await bcrypt.compare(senha, empresa.senha)) {
      req.session.userId = empresa.id;
      req.session.cnpj = empresa.cnpj;
      res.redirect("/empresa.html");
    } else {
      res.status(401).send("Credenciais inválidas.");
    }
  } catch (err) {
    console.error("Erro no login:", err.message);
    res.status(500).send("Erro ao fazer login.");
  }
});

// Upload de arquivos (feito pelo administrador)
app.post("/upload/:empresaId", async (req, res) => {
  const empresaId = req.params.empresaId;
  const { nomeArquivo, conteudo } = req.body;

  try {
    const empresa = db.prepare("SELECT * FROM empresas WHERE id = ?").get(empresaId);
    if (!empresa) {
      return res.status(404).send("Empresa não encontrada.");
    }

    const bucket = "arquivos";
    const caminho = `${empresa.cnpj}/${nomeArquivo}`;

    const { error: uploadError } = await supabase.storage.from(bucket).upload(caminho, Buffer.from(conteudo, "base64"), {
      contentType: "application/pdf",
      upsert: true, // <- substitui automaticamente se já existir
    });

    if (uploadError) {
      console.error("Erro no upload:", uploadError.message);
      return res.status(500).send("Erro ao enviar arquivo.");
    }

    db.prepare("INSERT INTO arquivos (empresa_id, nome, caminho) VALUES (?, ?, ?)")
      .run(empresaId, nomeArquivo, caminho);

    res.send("Arquivo enviado com sucesso.");
  } catch (err) {
    console.error("Erro no upload:", err.message);
    res.status(500).send("Erro interno.");
  }
});

// Listagem de arquivos para a empresa
app.get("/arquivos", authMiddleware, async (req, res) => {
  try {
    const arquivos = db.prepare("SELECT * FROM arquivos WHERE empresa_id = ?").all(req.session.userId);

    const arquivosComUrls = await Promise.all(
      arquivos.map(async (arquivo) => {
        const { data, error } = await supabase.storage.from("arquivos").createSignedUrl(arquivo.caminho, 60 * 60);
        return {
          ...arquivo,
          url: data?.signedUrl || null,
        };
      })
    );

    res.json(arquivosComUrls);
  } catch (err) {
    console.error("Erro ao listar arquivos:", err.message);
    res.status(500).send("Erro interno.");
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login.html");
});

// Inicializa servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
