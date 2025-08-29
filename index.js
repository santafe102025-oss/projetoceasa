require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ======================
// SUPABASE
// ======================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ======================
// MIDDLEWARES
// ======================
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));
app.use(bodyParser.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: "segredo_ceasa",
    resave: false,
    saveUninitialized: true,
  })
);

// Autenticação geral
function authMiddleware(req, res, next) {
  if (!req.session.userId && !req.session.isAdmin) {
    return res.redirect("/login");
  }
  next();
}

// Somente administradores
function adminMiddleware(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(403).send("Acesso negado. Apenas administradores.");
  }
  next();
}

// ======================
// ROTAS PÁGINAS
// ======================
app.get("/", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin");
  if (req.session.userId) return res.redirect("/empresa");
  return res.redirect("/login");
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/admin-login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

app.get("/empresa", authMiddleware, (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin");
  res.sendFile(path.join(__dirname, "public", "empresa.html"));
});

app.get("/admin", adminMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ======================
// CADASTRO E LOGIN
// ======================
app.post("/cadastro", async (req, res) => {
  const { nome, cnpj, box, email, senha } = req.body;
  try {
    const hash = await bcrypt.hash(senha, 10);

    const { error: insertError } = await supabase
      .from("empresas")
      .insert([{ nome, cnpj, box, email, senha: hash }]);

    if (insertError) {
      console.error("Erro ao cadastrar empresa:", insertError.message);
      return res.status(500).send("Erro ao cadastrar empresa.");
    }

    // Cria "pasta" no Supabase com arquivo .keep
    const bucket = "arquivos";
    const caminho = `${cnpj}/.keep`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(caminho, Buffer.from("", "utf-8"), {
        contentType: "text/plain",
        upsert: true,
      });

    if (uploadError) {
      console.error("Erro ao criar pasta no Supabase:", uploadError.message);
    }

    res.redirect("/login");
  } catch (err) {
    console.error("Erro no cadastro:", err.message);
    res.status(500).send("Erro ao cadastrar empresa.");
  }
});

app.post("/login", async (req, res) => {
  const { email, senha } = req.body;

  // Login administrador fixo
  if (email === "admin@ceasa.com" && senha === "ceasa123") {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }

  try {
    const { data: empresas, error } = await supabase
      .from("empresas")
      .select("*")
      .eq("email", email)
      .limit(1);

    if (error || empresas.length === 0) {
      return res.status(401).send("Credenciais inválidas.");
    }

    const empresa = empresas[0];
    const senhaOk = await bcrypt.compare(senha, empresa.senha);

    if (senhaOk) {
      req.session.userId = empresa.id;
      req.session.cnpj = empresa.cnpj;
      return res.redirect("/empresa");
    } else {
      return res.status(401).send("Credenciais inválidas.");
    }
  } catch (err) {
    console.error("Erro no login:", err.message);
    res.status(500).send("Erro ao fazer login.");
  }
});

// ======================
// UPLOAD & LISTAGEM
// ======================
app.post("/upload/:empresaId", adminMiddleware, async (req, res) => {
  const empresaId = req.params.empresaId;
  const { nomeArquivo, conteudo } = req.body;

  try {
    const { data: empresas } = await supabase
      .from("empresas")
      .select("*")
      .eq("id", empresaId)
      .limit(1);

    if (!empresas || empresas.length === 0) {
      return res.status(404).send("Empresa não encontrada.");
    }
    const empresa = empresas[0];

    const bucket = "arquivos";
    const caminho = `${empresa.cnpj}/${nomeArquivo}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(caminho, Buffer.from(conteudo, "base64"), {
        contentType: nomeArquivo.endsWith(".pdf")
          ? "application/pdf"
          : "application/octet-stream",
        upsert: true,
      });

    if (uploadError) {
      console.error("Erro no upload:", uploadError.message);
      return res.status(500).send("Erro ao enviar arquivo.");
    }

    const { error: insertError } = await supabase
      .from("arquivos")
      .insert([{ empresa_id: empresaId, nome: nomeArquivo, caminho }]);

    if (insertError) {
      console.error("Erro ao salvar metadados:", insertError.message);
    }

    res.send("Arquivo enviado com sucesso.");
  } catch (err) {
    console.error("Erro no upload:", err.message);
    res.status(500).send("Erro interno.");
  }
});

// 🔥 Listagem com filtro por mês/ano
app.get("/arquivos", authMiddleware, async (req, res) => {
  try {
    if (req.session.isAdmin) return res.status(403).send("Somente empresas acessam.");

    const empresaId = req.session.userId;
    const { mes, ano } = req.query;

    let { data: arquivos, error } = await supabase
      .from("arquivos")
      .select("*")
      .eq("empresa_id", empresaId)
      .order("data_upload", { ascending: false });

    if (error) {
      console.error("Erro ao buscar arquivos:", error.message);
      return res.status(500).send("Erro interno.");
    }

    // Aplica filtro se solicitado
    if (mes || ano) {
      arquivos = arquivos.filter((arq) => {
        const data = new Date(arq.data_upload);
        const m = String(data.getMonth() + 1).padStart(2, "0");
        const y = String(data.getFullYear());
        return (!mes || m === mes) && (!ano || y === ano);
      });
    }

    // Gera URLs assinadas
    const arquivosComUrls = await Promise.all(
      arquivos.map(async (arquivo) => {
        const { data, error } = await supabase.storage
          .from("arquivos")
          .createSignedUrl(arquivo.caminho, 60 * 60);

        return { ...arquivo, url: data?.signedUrl || null };
      })
    );

    res.json(arquivosComUrls);
  } catch (err) {
    console.error("Erro ao listar arquivos:", err.message);
    res.status(500).send("Erro interno.");
  }
});

// ======================
// LISTAR EMPRESAS (para admin)
// ======================
app.get("/empresas", adminMiddleware, async (req, res) => {
  try {
    const { data: empresas, error } = await supabase
      .from("empresas")
      .select("id, nome, cnpj, box, email");

    if (error) throw error;

    res.json(empresas);
  } catch (err) {
    console.error("Erro ao listar empresas:", err.message);
    res.status(500).send("Erro ao buscar empresas.");
  }
});

app.delete("/empresas/:id", adminMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    await supabase.from("arquivos").delete().eq("empresa_id", id);
    await supabase.from("empresas").delete().eq("id", id);

    res.send("Empresa excluída com sucesso");
  } catch (err) {
    console.error("Erro ao excluir empresa:", err.message);
    res.status(500).send("Erro ao excluir empresa");
  }
});

// ======================
// LOGOUT
// ======================
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// ======================
// INICIALIZA SERVIDOR
// ======================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
