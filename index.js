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

app.get("/cadastro", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cadastro.html"));
});

// ======================
// CADASTRO DE EMPRESA
// ======================
app.post("/cadastro", async (req, res) => {
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
    console.error("Erro no cadastro:", err.message);
    res.status(500).send("Erro ao cadastrar empresa.");
  }
});

// ======================
// LOGIN
// ======================
app.post("/login", async (req, res) => {
  const { usuario, cnpj, senha } = req.body;

  // Login administrador fixo
  if (usuario === "admin" && senha === "ceasa123") {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }

  try {
    let query = supabase.from("empresas").select("*").limit(1);

    if (usuario) {
      query = query.eq("usuario", usuario);
    } else if (cnpj) {
      query = query.eq("cnpj", cnpj);
    } else {
      return res.status(400).send("Informe usuário ou CNPJ.");
    }

    const { data: empresas, error } = await query;

    if (error || !empresas || empresas.length === 0) {
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
// LISTAR EMPRESAS (para admin)
// ======================
app.get("/empresas", adminMiddleware, async (req, res) => {
  try {
    const { data: empresas, error } = await supabase
      .from("empresas")
      .select("id, nome, cnpj, box, usuario");

    if (error) throw error;

    res.json(empresas);
  } catch (err) {
    console.error("Erro ao listar empresas:", err.message);
    res.status(500).send("Erro ao buscar empresas.");
  }
});

// ======================
// EXCLUIR EMPRESA (para admin)
// ======================
app.delete("/empresas/:id", adminMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    // Buscar empresa para pegar CNPJ
    const { data: empresa, error: selectError } = await supabase
      .from("empresas")
      .select("id, cnpj")
      .eq("id", id)
      .single();

    if (selectError || !empresa) {
      return res.status(404).send("Empresa não encontrada.");
    }

    // Excluir empresa do banco
    const { error: deleteError } = await supabase
      .from("empresas")
      .delete()
      .eq("id", id);

    if (deleteError) throw deleteError;

    // Excluir pasta da empresa no Storage
    const bucket = "arquivos";
    const prefix = `${empresa.cnpj}/`;

    const { data: arquivos, error: listError } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: 1000 });

    if (!listError && arquivos.length > 0) {
      const paths = arquivos.map((arq) => `${prefix}${arq.name}`);
      await supabase.storage.from(bucket).remove(paths);
    }

    res.json({ message: "Empresa e arquivos excluídos com sucesso!" });
  } catch (err) {
    console.error("Erro ao excluir empresa:", err.message);
    res.status(500).send("Erro ao excluir empresa.");
  }
});

// ======================
// LISTAR ARQUIVOS DA EMPRESA (para empresa logada)
// ======================
app.get("/meus-arquivos", authMiddleware, async (req, res) => {
  if (!req.session.cnpj) return res.status(403).send("Não autorizado");

  try {
    const bucket = "arquivos";
    const prefix = `${req.session.cnpj}/`;

    const { data: arquivos, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: 100 });

    if (error) throw error;

    // gera URLs temporárias
    const arquivosComLinks = await Promise.all(
      arquivos
        .filter((a) => a.name !== ".keep")
        .map(async (arq) => {
          const { data: urlData } = await supabase.storage
            .from(bucket)
            .createSignedUrl(`${prefix}${arq.name}`, 60 * 60); // 1h
          return { nome: arq.name, url: urlData.signedUrl };
        })
    );

    res.json(arquivosComLinks);
  } catch (err) {
    console.error("Erro ao listar arquivos:", err.message);
    res.status(500).send("Erro ao buscar arquivos.");
  }
});

// ======================
// LISTAR ARQUIVOS DA EMPRESA
// ======================
app.get("/arquivos", authMiddleware, async (req, res) => {
  try {
    const bucket = "arquivos";
    const cnpj = req.session.cnpj;

    // Lista arquivos dentro da pasta do CNPJ
    const { data: arquivos, error } = await supabase.storage
      .from(bucket)
      .list(`${cnpj}/`, { limit: 1000 });

    if (error) throw error;

    // Montar resposta com nome, data e URL pública temporária
    const lista = await Promise.all(
      arquivos.map(async (arq) => {
        // Ignora o ".keep"
        if (arq.name === ".keep") return null;

        // Gera URL de download (válida por 1 hora)
        const { data: urlData } = await supabase.storage
          .from(bucket)
          .createSignedUrl(`${cnpj}/${arq.name}`, 3600);

        return {
          nome: arq.name,
          data_upload: arq.created_at,
          url: urlData?.signedUrl || "#",
        };
      })
    );

    res.json(lista.filter(Boolean)); // remove nulls
  } catch (err) {
    console.error("Erro ao listar arquivos:", err.message);
    res.status(500).send("Erro ao listar arquivos.");
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
