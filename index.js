const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração do Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configuração do SQLite
const db = new sqlite3.Database('./database.sqlite');

// Criação das tabelas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    cnpj TEXT UNIQUE,
    box TEXT,
    email TEXT,
    senha TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS arquivos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER,
    nome TEXT,
    caminho TEXT,
    data_upload DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )`);
});

// Middlewares
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'secreta',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ===== ROTAS =====

// Rota inicial -> login
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Cadastro de empresa
app.post('/cadastrar', async (req, res) => {
  const { nome, cnpj, box, email, senha } = req.body;

  try {
    const hash = await bcrypt.hash(senha, 10);

    db.run(
      'INSERT INTO empresas (nome, cnpj, box, email, senha) VALUES (?, ?, ?, ?, ?)',
      [nome, cnpj, box, email, hash],
      function (err) {
        if (err) {
          return res.status(400).send('Erro: CNPJ ou Email já cadastrados.');
        }
        res.redirect('/');
      }
    );
  } catch (err) {
    res.status(500).send('Erro ao cadastrar empresa.');
  }
});

// Login
app.post('/login', (req, res) => {
  const { email, senha } = req.body;

  db.get('SELECT * FROM empresas WHERE email = ?', [email], async (err, empresa) => {
    if (err || !empresa) return res.status(401).send('Usuário não encontrado');

    const match = await bcrypt.compare(senha, empresa.senha);
    if (!match) return res.status(401).send('Senha incorreta');

    req.session.empresa = empresa;

    if (email === 'admin@ceasa.com') {
      res.redirect('/admin.html');
    } else {
      res.redirect('/empresa.html');
    }
  });
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// 🔹 Rota para listar empresas em JSON (usada pelo painel admin)
app.get('/empresas.json', (req, res) => {
  db.all('SELECT id, nome, cnpj, box FROM empresas', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar empresas' });
    }
    res.json(rows);
  });
});

// Upload de arquivos pelo admin para empresa específica
app.post('/upload/:empresaId', async (req, res) => {
  try {
    const empresaId = req.params.empresaId;
    const { nomeArquivo, conteudo } = req.body;

    // Nome único no bucket (por empresa)
    const filePath = `${empresaId}/${nomeArquivo}`;

    // Upload para Supabase
    const { error: uploadError } = await supabase.storage
      .from('arquivos')
      .upload(filePath, Buffer.from(conteudo, 'base64'), {
        contentType: 'application/pdf',
        upsert: true
      });

    if (uploadError) throw uploadError;

    // Salvar no banco
    db.run(
      'INSERT INTO arquivos (empresa_id, nome, caminho) VALUES (?, ?, ?)',
      [empresaId, nomeArquivo, filePath],
      function (err) {
        if (err) return res.status(500).send('Erro ao salvar no banco.');
        res.send('Arquivo enviado com sucesso.');
      }
    );
  } catch (err) {
    res.status(500).send('Erro no upload: ' + err.message);
  }
});

// Listar arquivos de uma empresa
app.get('/arquivos/:empresaId', (req, res) => {
  const empresaId = req.params.empresaId;

  db.all('SELECT * FROM arquivos WHERE empresa_id = ?', [empresaId], (err, rows) => {
    if (err) return res.status(500).send('Erro ao buscar arquivos.');
    res.json(rows);
  });
});

// Download de arquivo
app.get('/download/:empresaId/:arquivo', async (req, res) => {
  try {
    const { empresaId, arquivo } = req.params;
    const filePath = `${empresaId}/${arquivo}`;

    const { data, error } = await supabase.storage
      .from('arquivos')
      .createSignedUrl(filePath, 60);

    if (error) throw error;

    res.redirect(data.signedUrl);
  } catch (err) {
    res.status(500).send('Erro ao baixar arquivo.');
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
