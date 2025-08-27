require("dotenv").config();
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const Database = require("better-sqlite3");

// Inicializa o banco
const db = new Database("./database.db");

// Cria tabelas se não existirem
db.prepare(`
  CREATE TABLE IF NOT EXISTS empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    cnpj TEXT UNIQUE,
    senha TEXT,
    box TEXT
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS arquivos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER,
    nome TEXT,
    caminho TEXT,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )
`).run();

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Express
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: "segredo",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(express.static("public"));

// Configuração do Multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

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

// Login
app.post("/login", (req, res) => {
  const { cnpj, senha } = req.body;
  const empresa = db.prepare("SELECT * FROM empresas WHERE cnpj = ? AND senha = ?").get(cnpj, senha);

  if (empresa) {
    req.session.userId = empresa.id;
    req.session.cnpj = empresa.cnpj;
    res.redirect("/dashboard.html");
  } else {
    res.send("CNPJ ou senha inválidos");
  }
});

// Upload de arquivos pelo admin
app.post("/upload/:empresaId", upload.single("arquivo"), async (req, res) => {
  const { empresaId } = req.params;
  const empresa = db.prepare("SELECT * FROM empresas WHERE id = ?").get(empresaId);

  if (!empresa) {
    return res.status(400).send("Empresa não encontrada");
  }

  const arquivo = req.file;
  const nomeArquivo = arquivo.originalname;
  const caminho = `${empresa.cnpj}/${nomeArquivo}`;

  // Faz upload para Supabase (com replace = true)
  const { error } = await supabase.storage
    .from("arquivos")
    .upload(caminho, arquivo.buffer, {
      contentType: arquivo.mimetype,
      upsert: true
    });

  if (error) {
    console.error("Erro no upload:", error.message);
    return res.status(500).send("Erro no upload");
  }

  // Salva no banco
  db.prepare(
    "INSERT INTO arquivos (empresa_id, nome, caminho) VALUES (?, ?, ?)"
  ).run(empresaId, nomeArquivo, caminho);

  res.send("Arquivo enviado com sucesso!");
});

// Listar arquivos da empresa logada
app.get("/meus-arquivos", authMiddleware, async (req, res) => {
  const empresaId = req.session.userId;
  const arquivos = db.prepare("SELECT * FROM arquivos WHERE empresa_id = ?").all(empresaId);

  // Gera URLs públicas temporárias
  const listaComUrls = [];
  for (const arq of arquivos) {
    const { data, error } = await supabase.storage
      .from("arquivos")
      .createSignedUrl(arq.caminho, 60 * 60); // válido 1h

    if (!error) {
      listaComUrls.push({ nome: arq.nome, url: data.signedUrl });
    }
  }

  res.json(listaComUrls);
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login.html");
});

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
