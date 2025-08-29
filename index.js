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
// LOGS DAS VARIÁVEIS
// ======================
console.log("🔑 SUPABASE_URL:", process.env.SUPABASE_URL || "NÃO DEFINIDA");
console.log("🔑 SUPABASE_KEY:", process.env.SUPABASE_KEY ? "Definida" : "NÃO DEFINIDA");
console.log("🔑 SESSION_SECRET:", process.env.SESSION_SECRET ? "Definida" : "NÃO DEFINIDA");

// ======================
// SUPABASE
// ======================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Testa conexão inicial
(async () => {
  try {
    const { error } = await supabase.from("empresas").select("*").limit(1);
    if (error) {
      console.error("❌ Erro ao conectar Supabase:", error.message);
    } else {
      console.log("✅ Conexão Supabase funcionando!");
    }
  } catch (err) {
    console.error("❌ Erro Supabase (catch):", err.message);
  }
})();

// ======================
// CRIAR ADMIN AUTOMATICAMENTE
// ======================
async function criarAdmin() {
  try {
    const usuario = "admin";
    const senhaPura = "ceasa123";

    // Gera o hash da senha
    const hash = await bcrypt.hash(senhaPura, 10);

    // Faz o upsert (insere se não existir, atualiza se já existir)
    const { error } = await supabase
      .from("empresas")
      .upsert(
        [
          {
            cnpj: "00000000000000",
            nome: "Administrador",
            box: "0",
            usuario,
            senha: hash,
          },
        ],
        { onConflict: "usuario" }
      ); // garante que não duplica pelo campo usuario

    if (error) {
      console.error("❌ Erro ao criar admin:", error.message);
    } else {
      console.log("✅ Usuário admin pronto!");
    }
  } catch (err) {
    console.error("❌ Erro inesperado:", err.message);
  }
}

// chama essa função logo depois de conectar no supabase
criarAdmin();

// ======================
// MIDDLEWARES
// ======================
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));
app.use(bodyParser.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "segredo_default",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // em produção com HTTPS -> true
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

app.get("/cadastro", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cadastro.html"));
});

// ======================
// CADASTRO DE EMPRESA
// ======================
app.post("/cadastro", async (req, res, next) => {
  const { nome, cnpj, box, usuario, senha } = req.body;
  try {
    const hash = await bcrypt.hash(senha, 10);

    const { error: insertError } = await supabase
      .from("empresas")
      .insert([{ nome, cnpj, box, usuario, senha: hash }]);

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
    next(err);
  }
});

// ======================
// LOGIN
// ======================
app.post("/login", async (req, res, next) => {
  const { usuario, cnpj, senha } = req.body;
  console.log("🟢 LOGIN REQ BODY:", req.body);

  try {
    let query = supabase.from("empresas").select("*").limit(1);

    if (usuario) query = query.eq("usuario", usuario);
    else if (cnpj) query = query.eq("cnpj", cnpj);
    else return res.status(400).send("Informe usuário ou CNPJ.");

    const { data: empresas, error } = await query;
    console.log("📦 Resultado Supabase:", { empresas, error });

    if (error || !empresas || empresas.length === 0) {
      return res.status(401).send("Credenciais inválidas.");
    }

    const empresa = empresas[0];
    const senhaOk = await bcrypt.compare(senha, empresa.senha);
    console.log("🔑 Senha válida?", senhaOk);

    if (senhaOk) {
      req.session.userId = empresa.id;
      req.session.cnpj = empresa.cnpj;
      if (empresa.usuario === "admin") {
        req.session.isAdmin = true;
        return res.redirect("/admin");
      }
      return res.redirect("/empresa");
    } else {
      return res.status(401).send("Credenciais inválidas.");
    }
  } catch (err) {
    console.error("🔥 Erro login:", err.message);
    next(err);
  }
});

// ======================
// LISTAR EMPRESAS (para admin)
// ======================
app.get("/empresas", adminMiddleware, async (req, res, next) => {
  try {
    const { data: empresas, error } = await supabase
      .from("empresas")
      .select("id, nome, cnpj, box, usuario");

    if (error) throw error;

    res.json(empresas);
  } catch (err) {
    next(err);
  }
});

// ======================
// EXCLUIR EMPRESA (para admin)
// ======================
app.delete("/empresas/:id", adminMiddleware, async (req, res, next) => {
  const { id } = req.params;

  try {
    const { data: empresa, error: selectError } = await supabase
      .from("empresas")
      .select("id, cnpj")
      .eq("id", id)
      .single();

    if (selectError || !empresa) {
      return res.status(404).send("Empresa não encontrada.");
    }

    const { error: deleteError } = await supabase
      .from("empresas")
      .delete()
      .eq("id", id);

    if (deleteError) throw deleteError;

    const bucket = "arquivos";
    const prefix = `${empresa.cnpj}/`;

    const { data: arquivos, error: listError } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: 1000 });

    if (!listError && arquivos && arquivos.length > 0) {
      const paths = arquivos.map((arq) => `${prefix}${arq.name}`);
      await supabase.storage.from(bucket).remove(paths);
    }

    res.json({ message: "Empresa e arquivos excluídos com sucesso!" });
  } catch (err) {
    next(err);
  }
});

// ======================
// LISTAR ARQUIVOS DA EMPRESA
// ======================
app.get("/arquivos", authMiddleware, async (req, res, next) => {
  try {
    const bucket = "arquivos";
    const cnpj = req.session.cnpj;

    const { data: arquivos, error } = await supabase.storage
      .from(bucket)
      .list(`${cnpj}/`, { limit: 1000 });

    if (error) throw error;

    const lista = await Promise.all(
      arquivos.map(async (arq) => {
        if (arq.name === ".keep") return null;

        const { data: urlData } = await supabase.storage
          .from(bucket)
          .createSignedUrl(`${cnpj}/${arq.name}`, 3600);

        return {
          nome: arq.name,
          url: urlData?.signedUrl || "#",
        };
      })
    );

    res.json(lista.filter(Boolean));
  } catch (err) {
    next(err);
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
// MIDDLEWARE DE ERRO GLOBAL
// ======================
app.use((err, req, res, next) => {
  console.error("🔥 Erro no servidor:", err.stack);
  res.status(500).send("Erro interno no servidor: " + err.message);
});

// ======================
// INICIALIZA SERVIDOR
// ======================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
