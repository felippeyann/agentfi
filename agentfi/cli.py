"""Command-line interface for AgentFi."""

from __future__ import annotations

import sys

import click

from .agent import Agent


@click.group()
@click.version_option(package_name="agentfi")
def cli() -> None:
    """AgentFi – AI-powered financial analysis agent."""


@cli.command()
@click.option(
    "--model",
    default="gpt-4o-mini",
    show_default=True,
    help="OpenAI model to use.",
)
@click.option(
    "--api-key",
    envvar="OPENAI_API_KEY",
    default=None,
    help="OpenAI API key (defaults to OPENAI_API_KEY env var).",
)
def chat(model: str, api_key: str | None) -> None:
    """Start an interactive chat session with AgentFi."""
    agent = Agent(api_key=api_key, model=model)
    click.echo("AgentFi – type 'exit' or press Ctrl-C to quit.\n")
    try:
        while True:
            try:
                user_input = click.prompt("You", prompt_suffix="> ")
            except click.Abort:
                click.echo("\nGoodbye!")
                break

            if user_input.strip().lower() in {"exit", "quit", "q"}:
                click.echo("Goodbye!")
                break

            reply = agent.chat(user_input)
            click.echo(f"\nAgentFi> {reply}\n")
    except KeyboardInterrupt:
        click.echo("\nGoodbye!")


@cli.command()
@click.argument("ticker")
@click.option(
    "--api-key",
    envvar="OPENAI_API_KEY",
    default=None,
    help="OpenAI API key (defaults to OPENAI_API_KEY env var).",
)
def quote(ticker: str, api_key: str | None) -> None:
    """Get a quick stock quote for TICKER."""
    from .tools import get_stock_quote  # noqa: PLC0415

    data = get_stock_quote(ticker)
    click.echo(f"Symbol:     {data['symbol']}")
    click.echo(f"Price:      {data['price']} {data['currency']}")
    click.echo(f"Change:     {data['change']} ({data['change_pct']}%)")
    click.echo(f"Volume:     {data['volume']}")
    click.echo(f"Market Cap: {data['market_cap']}")


@cli.command()
@click.argument("ticker")
@click.option(
    "--period",
    default="1mo",
    show_default=True,
    help="History period (1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max).",
)
@click.option(
    "--interval",
    default="1d",
    show_default=True,
    help="Bar interval (1m, 5m, 15m, 1h, 1d, 1wk, 1mo, ...).",
)
def history(ticker: str, period: str, interval: str) -> None:
    """Fetch price history for TICKER."""
    from .tools import get_stock_history  # noqa: PLC0415

    rows = get_stock_history(ticker, period=period, interval=interval)
    if not rows:
        click.echo("No data returned.")
        return
    header = f"{'Date':<30} {'Open':>10} {'High':>10} {'Low':>10} {'Close':>10} {'Volume':>15}"
    click.echo(header)
    click.echo("-" * len(header))
    for row in rows:
        click.echo(
            f"{row['date']:<30} {row['open']:>10.2f} {row['high']:>10.2f} "
            f"{row['low']:>10.2f} {row['close']:>10.2f} {row['volume']:>15,}"
        )


@cli.command()
@click.argument("ticker")
def info(ticker: str) -> None:
    """Show company information for TICKER."""
    from .tools import get_stock_info  # noqa: PLC0415

    data = get_stock_info(ticker)
    for key, value in data.items():
        if key == "description" and value:
            click.echo(f"\n{key.capitalize()}:\n  {value}\n")
        else:
            click.echo(f"{key:<15} {value}")


@cli.command()
@click.argument("ticker")
def financials(ticker: str) -> None:
    """Show key financial metrics for TICKER."""
    from .tools import get_financials  # noqa: PLC0415

    data = get_financials(ticker)
    for key, value in data.items():
        click.echo(f"{key:<20} {value}")


def main() -> None:
    """Entry point."""
    cli()


if __name__ == "__main__":
    main()
