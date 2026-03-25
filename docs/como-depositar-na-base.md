# Como depositar ETH na Base — Tutorial completo

Base é uma rede criada pela Coinbase que funciona "em cima" do Ethereum.
Mesmos endereços, mesmas carteiras — mas transações 100x mais baratas.

---

## O que você vai precisar

- Uma carteira (MetaMask, Coinbase Wallet, ou qualquer outra)
- Um pouco de ETH (0.005 ETH é suficiente para todos os testes)

---

## OPÇÃO A — Você já tem ETH em alguma exchange (Binance, Coinbase, etc.)

Essa é a opção mais simples se você já tem ETH comprado.

### Passo 1 — Adicionar a rede Base na sua carteira

Se usar MetaMask:

1. Abra o MetaMask
2. Clique na lista de redes no topo (onde diz "Ethereum Mainnet")
3. Clique em "Adicionar rede"
4. Clique em "Adicionar uma rede manualmente" e preencha:

   ```
   Nome da rede:    Base
   URL do RPC:      https://mainnet.base.org
   Chain ID:        8453
   Símbolo:         ETH
   Block explorer:  https://basescan.org
   ```

5. Salve e mude para a rede Base

> Atalho: também pode adicionar automaticamente em https://chainlist.org — busca "Base" e clica "Add to MetaMask"

---

### Passo 2 — Sacar ETH da exchange direto para a Base

Na maioria das exchanges grandes (Binance, Coinbase, Bybit, etc.):

1. Vá em "Sacar" / "Withdraw"
2. Selecione ETH
3. Na rede de saque, escolha **"Base"** (se disponível)
4. Cole o endereço da carteira do agente:
   ```
   0x61fb281349dB2f4B790472679B65002BbbD90ea3
   ```
5. Valor: `0.005 ETH`
6. Confirme o saque

⚠️ **Atenção:** escolha sempre a rede **Base**, não "ERC-20" (que é Ethereum mainnet).
Se mandar pela rede errada, os fundos ficam em outra rede e não chegam onde precisa.

A Coinbase suporta saque direto para Base sem taxas extras.
A Binance cobra uma pequena taxa mas funciona normalmente.

---

## OPÇÃO B — Você tem ETH no Ethereum mainnet e quer mover para a Base

Nesse caso você precisa de uma "ponte" (bridge).

### Bridge oficial da Base (mais seguro)

1. Acesse https://bridge.base.org
2. Conecte sua carteira
3. Selecione:
   - De: Ethereum
   - Para: Base
   - Token: ETH
   - Valor: 0.005 ETH
4. Clique em "Bridge"
5. Confirme a transação na MetaMask

Tempo: ~10 minutos
Taxa: ~$1-3 em gas do Ethereum

---

## OPÇÃO C — Você tem USDC ou outra stablecoin

Se preferir testar com USDC ao invés de ETH:

1. Use a bridge acima mas mande USDC ao invés de ETH
2. Mande também 0.001 ETH separado para pagar gas (ETH é sempre necessário para gas, mesmo que o swap seja em USDC)
3. Endereço do agente: `0x61fb281349dB2f4B790472679B65002BbbD90ea3`

---

## Como verificar se chegou

Acesse: https://basescan.org/address/0x61fb281349dB2f4B790472679B65002BbbD90ea3

Você verá:
- O saldo de ETH
- O histórico de transações
- Qualquer token ERC-20 que tiver lá

Isso é o "extrato bancário" público do endereço. Qualquer um pode ver, mas só o AgentFi (via Turnkey) pode mover os fundos.

---

## Resumo visual

```
Sua exchange / carteira pessoal
        |
        | saque direto pela rede Base
        | (ou bridge se vier do Ethereum)
        ↓
0x61fb281349dB2f4B790472679B65002BbbD90ea3
        (carteira do agente test-agent-1 na Base)
        |
        | controlada pelo Turnkey MPC
        | assinada pelo AgentFi backend
        ↓
   Transações DeFi (Uniswap, Aave, etc.)
```

---

## Perguntas frequentes

**Posso mandar para o endereço errado?**
Se mandar pela rede Base, chega certo. Se mandar pela rede Ethereum, vai para o mesmo endereço mas na rede Ethereum — os fundos não aparecem na Base. Nesse caso é recuperável: só precisaria adicionar a rede Ethereum na carteira do agente.

**Quanto tempo demora?**
- Saque de exchange para Base: 5-30 minutos (depende da exchange)
- Bridge Ethereum → Base: ~10 minutos

**O endereço muda conforme a rede?**
Não. O endereço `0x61fb28...` é o mesmo na Base, Ethereum, Arbitrum e qualquer rede EVM. O que muda é qual rede você usa para enviar.

**Posso recuperar os fundos se algo der errado?**
Sim. O operador (você) tem acesso ao kill switch e pode pausar o agente a qualquer momento pelo painel admin em http://localhost:3001. Os fundos nunca saem sem uma transação assinada pelo Turnkey.

---

## Quando confirmar

Quando o Basescan mostrar saldo, avise e executamos o primeiro swap real:
o agente vai trocar uma parte do ETH por USDC via Uniswap V3 na Base, tudo automaticamente.
