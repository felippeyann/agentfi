# Deploy dos Contratos — AgentFi na Base

## O que vai ser deployado

| Contrato | Função |
|----------|--------|
| `AgentPolicyModule` | Valida limites de cada agente on-chain (kill switch, valor máximo, whitelist) |
| `AgentExecutor` | Executa batches de ações + coleta fee automaticamente → manda para tua carteira |

Após o deploy, cada transação do AgentFi passa pelo `AgentExecutor` que:
1. Executa o swap/transfer/deposit
2. Calcula `fee = value * 30bps / 10000`
3. Transfere fee para `0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646` na mesma tx
4. Devolve qualquer excesso ao agente

---

## PASSO 1 — Instalar Foundry (Windows)

Abre o PowerShell como Administrador e roda:

```powershell
# Instala via winget (mais simples no Windows)
winget install --id Foundry.Foundryup

# Ou via curl (Git Bash / WSL)
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Verifica:
```powershell
forge --version
# Deve mostrar: forge 0.2.x (...)
```

Se `forge` não for reconhecido após instalar, fecha e reabre o terminal.

---

## PASSO 2 — Instalar dependências do contrato

```powershell
cd "C:\Users\felip\OneDrive\Área de Trabalho\agentfi\packages\contracts"
forge install foundry-rs/forge-std --no-commit
```

---

## PASSO 3 — Variáveis de ambiente para o deploy

Precisas de uma carteira com ETH na Base para pagar o gas.
O deploy custa ~$0.50-$2.00 na Base.

Abre o PowerShell e define as variáveis:

```powershell
# Chave privada da carteira que vai pagar o gas
# ATENÇÃO: use uma carteira só para deploy, não a principal
$env:PRIVATE_KEY = "0xSUA_PRIVATE_KEY_AQUI"

# Teu endereço MetaMask (operador — pode pausar agentes)
$env:OPERATOR_ADDRESS = "0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646"

# Carteira que recebe as fees (mesma do OPERATOR_FEE_WALLET)
$env:FEE_WALLET = "0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646"

# Fee em basis points: 30 = 0.30% (tier FREE)
$env:FEE_BPS = "30"
```

---

## PASSO 4 — Testar localmente antes de deployar

```powershell
cd "C:\Users\felip\OneDrive\Área de Trabalho\agentfi\packages\contracts"
forge test -vvv
```

Todos os testes devem passar antes de deployar.

---

## PASSO 5 — Deploy na Base

```powershell
cd "C:\Users\felip\OneDrive\Área de Trabalho\agentfi\packages\contracts"

forge script script/Deploy.s.sol `
  --rpc-url https://mainnet.base.org `
  --broadcast `
  --verify `
  --etherscan-api-key SUA_BASESCAN_API_KEY
```

> Para pegar uma Basescan API key gratuita: https://basescan.org/myapikey

O output vai mostrar algo assim:
```
AgentPolicyModule: 0xABCD...
AgentExecutor:     0xEFGH...

--- Copy to .env ---
POLICY_MODULE_ADDRESS_8453=0xABCD...
EXECUTOR_ADDRESS_8453=0xEFGH...
```

---

## PASSO 6 — Atualizar o .env

Copia as linhas impressas no output para o arquivo `.env`:

```
POLICY_MODULE_ADDRESS_8453=0xABCD...
EXECUTOR_ADDRESS_8453=0xEFGH...
```

---

## PASSO 7 — Verificar o deploy

Após deployar, verifica os contratos no Basescan:
- `AgentPolicyModule`: https://basescan.org/address/0xABCD...
- `AgentExecutor`: https://basescan.org/address/0xEFGH...

Clica em "Contract" → "Read Contract" e verifica:
- `feeWallet()` → deve retornar teu endereço
- `feeBps()` → deve retornar `30`
- `operator()` → deve retornar teu endereço (no PolicyModule)

---

## Como funciona a fee após o deploy

Antes do deploy (agora):
```
Agente → Uniswap → recebe USDC
Fee: registrada no banco mas não transferida on-chain
```

Após o deploy:
```
Agente → AgentExecutor → Uniswap → recebe USDC
                      ↓
              0.30% vai para 0xD73d0c... na mesma tx
```

O backend vai detectar automaticamente os endereços deployados via `.env`
e rotear todas as transações pelo `AgentExecutor`.

---

## Contratos Deployados (Base Mainnet — Chain 8453)

| Contrato | Endereço |
|----------|---------|
| AgentPolicyModule | [`0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d`](https://basescan.org/address/0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d) |
| AgentExecutor | [`0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3`](https://basescan.org/address/0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3) |

**Deployer:** `0x2530c24Be25100C3f313D3F6BF36557a7b02A41b`
**Fee Wallet:** `0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646`
**Fee BPS:** 30 (0.30%)

---

## Deploy em outros networks

```powershell
# Ethereum Mainnet
forge script script/Deploy.s.sol --rpc-url mainnet --broadcast --verify

# Arbitrum One
forge script script/Deploy.s.sol --rpc-url arbitrum --broadcast --verify

# Polygon
forge script script/Deploy.s.sol --rpc-url polygon --broadcast --verify
```

Após cada deploy, atualizar `.env` com os novos endereços e adicionar no Railway.
