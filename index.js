require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const multer = require("multer");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// ===================== SUPABASE =====================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ===================== BANCO DE DADOS =====================
const db = new sqlite3.Database("./banco.db");

db.serialize(() => {
  // Criar tabela empresas
  db.run(`CREATE TABLE IF NOT EXISTS empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT UNIQUE,
    nome TEXT,
    box TEXT,
    usuario TEXT,
    senha TEXT
  )`);

  // Criar tabela arquivos
  db.run(`CREATE TABLE IF NOT EXISTS arquivos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER,
    nome TEXT,
    caminho TEXT
  )`);

  // Verificar se "caminho" existe, se não, adicionar
  db.all(`PRAGMA table_info(arquivos);`, (err, columns) => {
    if (err) return console.error(err.message);
    const colNames = columns.map(c => c.name);
    if (!colNames.includes("caminho")) {
      db.run(`ALTER TABLE arquivos ADD COLUMN caminho TEXT`, (err) => {
        if (err) {
          console.error("Erro ao adicionar coluna 'caminho':", err.message);
        } else {
          console.log("✅ Coluna 'caminho' adicionada com sucesso!");
        }
      });
    }
  });
});

// ===================== CONFIGURAÇÃO =====================
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(
  session({
    secret: "segredo",
    resave: false,
    saveUninitialized: true,
  })
);

// ===================== VARIÁVEIS =====================
const ADMIN_USER = "admin";
const ADMIN_PASS = "1234";

// ===================== ROTAS =====================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/login.html"));
});

app.post("/login", (req, res) => {
  const { usuario, senha } = req.body;

  if (usuario === ADMIN_USER && senha === ADMIN_PASS) {
    req.session.admin = true;
    return res.redirect("/admin");
  }

  db.get(
    "SELECT * FROM empresas WHERE (cnpj = ? OR usuario = ?)",
    [usuario, usuario],
    async (err, empresa) => {
      if (err || !empresa) return res.send("Usuário não encontrado.");
      const ok = await bcrypt.compare(senha, empresa.senha);
      if (!ok) return res.send("Senha incorreta.");
      req.session.empresa = empresa;
      res.redirect("/empresa");
    }
  );
});

// ===================== ADMIN =====================
app.get("/admin", (req, res) => {
  if (!req.session.admin) return res.redirect("/");

  db.all("SELECT * FROM empresas", (err, empresas) => {
    if (err) return res.send("Erro no banco.");
    let html = `
      <h1>Painel do Administrador</h1>
      <form method="get" action="/logout"><button>Sair</button></form>
      <h2>Empresas</h2>
      <form method="get" action="/cadastro"><button>Cadastrar Empresa</button></form>
      <br><br>
      <form method="get" action="/admin">
        <input type="text" name="filtro" placeholder="Buscar por CNPJ, Nome ou Box">
        <button type="submit">Filtrar</button>
      </form>
      <br>
    `;

    const filtro = req.query.filtro ? req.query.filtro.toLowerCase() : null;
    empresas
      .filter(
        (e) =>
          !filtro ||
          e.cnpj.toLowerCase().includes(filtro) ||
          e.nome.toLowerCase().includes(filtro) ||
          e.box.toLowerCase().includes(filtro)
      )
      .forEach((e) => {
        html += `
          <div style="border:1px solid #ccc; margin:5px; padding:5px">
            <b>${e.nome}</b> - CNPJ: ${e.cnpj} - Box: ${e.box}
            <form method="post" action="/upload/${e.id}" enctype="multipart/form-data">
              <input type="file" name="arquivo" required>
              <button type="submit">Enviar PDF</button>
            </form>
          </div>`;
      });

    res.send(html);
  });
});

// Upload de arquivos (admin escolhe empresa)
app.post("/upload/:empresaId", upload.single("arquivo"), async (req, res) => {
  if (!req.session.admin) return res.redirect("/");

  const empresaId = req.params.empresaId;
  const arquivo = req.file;

  if (!arquivo) return res.send("Nenhum arquivo enviado.");

  db.get("SELECT * FROM empresas WHERE id = ?", [empresaId], async (err, empresa) => {
    if (err || !empresa) return res.send("Empresa não encontrada.");

    const filePathSupabase = `${empresa.cnpj}/${arquivo.originalname}`;

    // Upload para Supabase com substituição
    const { error } = await supabase.storage
      .from("arquivos")
      .upload(filePathSupabase, arquivo.buffer, {
        contentType: "application/pdf",
        upsert: true, // 🔹 substitui se já existir
      });

    if (error) {
      console.error("Erro no upload:", error);
      return res.send("❌ Erro no upload: " + error.message);
    }

    db.run(
      "INSERT INTO arquivos (empresa_id, nome, caminho) VALUES (?, ?, ?) ",
      [empresa.id, arquivo.originalname, filePathSupabase],
      (err) => {
        if (err) console.error("Erro no banco:", err.message);
      }
    );

    res.send("✅ Arquivo enviado com sucesso!");
  });
});

// ===================== EMPRESAS =====================
app.get("/empresa", (req, res) => {
  if (!req.session.empresa) return res.redirect("/");

  db.all(
    "SELECT * FROM arquivos WHERE empresa_id = ?",
    [req.session.empresa.id],
    async (err, arquivos) => {
      if (err) return res.send("Erro no banco.");

      let html = `<h1>Área da Empresa - ${req.session.empresa.nome}</h1>
      <form method="get" action="/logout"><button>Sair</button></form>
      <h2>Meus Arquivos</h2>`;

      for (let arq of arquivos) {
        const { data } = await supabase.storage
          .from("arquivos")
          .createSignedUrl(arq.caminho, 60 * 60); // válido por 1h
        html += `<p><a href="${data.signedUrl}" target="_blank">${arq.nome}</a></p>`;
      }

      if (arquivos.length === 0) html += "<p>Nenhum arquivo disponível.</p>";

      res.send(html);
    }
  );
});

// ===================== CADASTRO DE EMPRESAS =====================
app.get("/cadastro", (req, res) => {
  if (!req.session.admin) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public/cadastro.html"));
});

app.post("/cadastro", async (req, res) => {
  const { cnpj, nome, box, usuario, senha } = req.body;
  const hash = await bcrypt.hash(senha, 10);

  db.run(
    "INSERT INTO empresas (cnpj, nome, box, usuario, senha) VALUES (?, ?, ?, ?, ?)",
    [cnpj, nome, box, usuario, hash],
    (err) => {
      if (err) return res.send("Erro ao cadastrar: " + err.message);
      res.redirect("/admin");
    }
  );
});

// ===================== LOGOUT =====================
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

// ===================== INICIAR SERVIDOR =====================
app.listen(3000, () => console.log("🚀 Servidor rodando em http://localhost:3000"));
