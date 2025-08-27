import express from "express";
import session from "express-session";
import multer from "multer";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.urlencoded({ extended: true }));

// 🔑 Sessões
app.use(session({
  secret: "chave-secreta",
  resave: false,
  saveUninitialized: false,
}));

// 📂 Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 📂 Banco SQLite
const db = await open({
  filename: "banco.db",
  driver: sqlite3.Database,
});

// cria tabelas se não existirem
await db.exec(`
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT,
  cnpj TEXT UNIQUE,
  box TEXT,
  email TEXT,
  senha TEXT
);

CREATE TABLE IF NOT EXISTS arquivos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER,
  nome TEXT,
  caminho TEXT,
  FOREIGN KEY (empresa_id) REFERENCES empresas(id)
);
`);

// ⬆️ Upload com multer (temporário antes de mandar p/ supabase)
const upload = multer({ dest: "uploads/" });

// 🔹 Rotas de páginas
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/login.html"));

// 🔹 Cadastro
app.post("/cadastro", async (req, res) => {
  const { empresa, cnpj, box, email, senha } = req.body;
  try {
    await db.run(
      "INSERT INTO empresas (nome, cnpj, box, email, senha) VALUES (?, ?, ?, ?, ?)",
      [empresa, cnpj, box, email, senha]
    );
    res.redirect("/login.html");
  } catch (err) {
    console.error("Erro cadastro:", err);
    res.send("Erro ao cadastrar: " + err.message);
  }
});

// 🔹 Login
app.post("/login", async (req, res) => {
  const { cnpj, senha } = req.body;
  if (cnpj === "admin" && senha === "admin") {
    req.session.admin = true;
    return res.redirect("/admin.html");
  }

  const empresa = await db.get("SELECT * FROM empresas WHERE cnpj=? AND senha=?", [cnpj, senha]);
  if (empresa) {
    req.session.empresa = empresa;
    return res.redirect("/empresa.html");
  }

  res.send("CNPJ ou senha incorretos");
});

// 🔹 Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

// 🔹 Lista de empresas para admin (AJAX)
app.get("/admin/empresas", async (req, res) => {
  if (!req.session.admin) return res.status(403).send("Não autorizado");
  const empresas = await db.all("SELECT * FROM empresas");
  res.json(empresas);
});

// 🔹 Upload de arquivos pelo admin
app.post("/admin/upload", upload.single("arquivo"), async (req, res) => {
  if (!req.session.admin) return res.status(403).send("Não autorizado");

  const empresaId = req.body.empresa;
  const arquivo = req.file;

  // envia para supabase
  const { error } = await supabase.storage
    .from("arquivos")
    .upload(`${empresaId}/${arquivo.originalname}`, arquivo.buffer, {
      upsert: true,
      contentType: arquivo.mimetype,
    });

  if (error) {
    console.error("Erro upload supabase:", error.message);
    return res.send("Erro ao enviar arquivo");
  }

  await db.run(
    "INSERT OR REPLACE INTO arquivos (empresa_id, nome, caminho) VALUES (?, ?, ?)",
    [empresaId, arquivo.originalname, `${empresaId}/${arquivo.originalname}`]
  );

  res.redirect("/admin.html");
});

// 🔹 Lista de arquivos da empresa
app.get("/empresa/arquivos", async (req, res) => {
  if (!req.session.empresa) return res.status(403).send("Não autorizado");

  const arquivos = await db.all("SELECT * FROM arquivos WHERE empresa_id=?", [req.session.empresa.id]);

  // gera links públicos
  const result = await Promise.all(
    arquivos.map(async (a) => {
      const { data } = await supabase.storage.from("arquivos").getPublicUrl(a.caminho);
      return { ...a, url: data.publicUrl };
    })
  );

  res.json(result);
});


// 🚀 Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
