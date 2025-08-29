// gera-hash.js
const bcrypt = require("bcrypt");

async function gerarHash() {
  const senha = "ceasa123";
  const hash = await bcrypt.hash(senha, 10);
  console.log("Hash gerado para 'ceasa123':", hash);
}

gerarHash();
