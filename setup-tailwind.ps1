# Limpar node_modules e cache
Write-Host "🧹 Limpando arquivos antigos..."
if (Test-Path "node_modules") { Remove-Item -Recurse -Force "node_modules" }
if (Test-Path "package-lock.json") { Remove-Item -Force "package-lock.json" }
npm cache clean --force

# Instalar dependências Tailwind + PostCSS + Autoprefixer
Write-Host "⬇️ Instalando Tailwind e dependências..."
npm install -D tailwindcss postcss autoprefixer

# Inicializar configuração do Tailwind
Write-Host "⚙️ Criando arquivos de configuração..."
npx tailwindcss init -p

Write-Host "✅ Configuração concluída!"
