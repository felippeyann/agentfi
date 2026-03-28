# AgentFi

**AgentFi** is an AI-powered financial analysis agent that combines OpenAI's tool-calling with real-time and historical stock market data (via [yfinance](https://github.com/ranaroussi/yfinance)).

## Features

- 💬 **Conversational agent** – ask natural-language questions about stocks and get data-driven answers
- 📈 **Real-time quotes** – price, change, volume, market cap
- 📊 **Historical OHLCV data** – flexible period and interval options
- 🏢 **Company info** – sector, industry, country, description
- 💰 **Financial metrics** – P/E ratio, EPS, dividend yield, beta, 52-week range, revenue, net income
- 🖥️ **CLI** – standalone commands for quick lookups without the AI layer

## Installation

```bash
pip install agentfi
```

Or from source:

```bash
git clone https://github.com/felippeyann/agentfi.git
cd agentfi
pip install -e .
```

## Usage

### Interactive chat

```bash
export OPENAI_API_KEY=sk-...

agentfi chat
# AgentFi – type 'exit' or press Ctrl-C to quit.
# You> What is Apple's current P/E ratio?
# AgentFi> Apple (AAPL) currently has a trailing P/E ratio of approximately 28.5 ...
```

### Quick quote

```bash
agentfi quote AAPL
# Symbol:     AAPL
# Price:      180.0 USD
# Change:     5.0 (2.857%)
# ...
```

### Price history

```bash
agentfi history AAPL --period 3mo --interval 1wk
```

### Company info

```bash
agentfi info MSFT
```

### Financial metrics

```bash
agentfi financials TSLA
```

## Python API

```python
from agentfi import Agent, get_stock_quote, get_stock_history

# Single tool call
quote = get_stock_quote("AAPL")
print(quote["price"])

# Conversational agent
agent = Agent()  # uses OPENAI_API_KEY env var
reply = agent.chat("Compare Apple and Microsoft's P/E ratios.")
print(reply)
```

## Configuration

| Variable | Description | Default |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API key | *(required for chat)* |

The `--model` flag (or `model=` parameter) lets you choose any OpenAI chat model, e.g. `gpt-4o`, `gpt-4o-mini` (default).

## Development

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT
