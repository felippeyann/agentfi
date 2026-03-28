# agentfi

**agentfi** is an AI-powered financial analysis agent. It provides a Python library and a command-line interface to query live stock data, compute returns and volatility statistics, and compare multiple tickers — with optional OpenAI LLM integration for natural-language answers.

## Features

- 📈 **Live stock quotes** — price, change, volume, market cap
- 📅 **Price history** — OHLCV data for any supported period/interval
- 🏢 **Company fundamentals** — sector, P/E, P/B, dividend yield, beta, and more
- 📊 **Return statistics** — total return and annualised volatility
- ⚡ **Multi-stock comparison** — rank stocks by performance
- 💬 **Natural-language chat** — rule-based dispatcher (no API key required) or optional OpenAI GPT integration

## Installation

```bash
pip install agentfi
# For OpenAI LLM support:
pip install "agentfi[llm]"
```

## CLI usage

```bash
# Latest quote
agentfi quote AAPL

# Company information
agentfi info MSFT

# Price history (default: 1 month, daily)
agentfi history TSLA --period 3mo --interval 1d

# Return statistics
agentfi returns NVDA --period 1y

# Compare multiple stocks
agentfi compare AAPL MSFT GOOG --period 1y

# Natural-language question (rule-based, no API key needed)
agentfi chat "What is the return of TSLA over the past year?"

# With OpenAI integration
OPENAI_API_KEY=sk-... agentfi chat "Compare Apple and Microsoft over 6 months"
```

## Python API

```python
from agentfi import Agent, get_stock_quote, calculate_returns, compare_stocks

# Direct tool calls
quote = get_stock_quote("AAPL")
print(quote)

stats = calculate_returns("TSLA", period="1y")
print(stats)

rankings = compare_stocks(["AAPL", "MSFT", "GOOG"], period="1y")
for r in rankings:
    print(r["ticker"], r["total_return_pct"])

# Agent (rule-based)
agent = Agent()
print(agent.run("What is the price of NVDA?"))

# Agent with OpenAI
agent = Agent(openai_api_key="sk-...")
print(agent.run("Summarise the financial performance of Apple over the last year."))
```

## Requirements

- Python ≥ 3.10
- [yfinance](https://github.com/ranaroussi/yfinance) ≥ 0.2
- [requests](https://docs.python-requests.org/) ≥ 2.28
- Optional: [openai](https://github.com/openai/openai-python) ≥ 1.0

## License

MIT

