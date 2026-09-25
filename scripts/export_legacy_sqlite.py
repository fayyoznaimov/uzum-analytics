#!/usr/bin/env python3
"""Экспортирует старую SQLite-базу бота в CSV без токенов и настроек."""
import argparse
import csv
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("db", help="Путь к uzum_bot.db")
parser.add_argument("--output", default="legacy_orders.csv")
args = parser.parse_args()

source = Path(args.db)
if not source.exists():
    raise SystemExit(f"Файл не найден: {source}")

with sqlite3.connect(source) as conn, open(args.output, "w", newline="", encoding="utf-8-sig") as target:
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT item_id, order_id, status, state, date_issued,
               sku_title, sell_price, amount, amount_returns, updated_at
        FROM orders
        ORDER BY updated_at
    """)
    writer = csv.writer(target, delimiter=";")
    writer.writerow(["item_id", "order_id", "status", "state", "date_issued", "sku_title", "sell_price", "amount", "amount_returns", "updated_at"])
    count = 0
    for row in rows:
        writer.writerow([row[key] for key in row.keys()])
        count += 1
print(f"Экспортировано строк: {count}. Файл: {args.output}")
