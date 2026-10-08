"""How good are the flags? The only place ground-truth labels are read.

Joins the server's precomputed cases to the event log's labels by purchase-
order number and reports what an auditor working the flagged list would see.

Usage:
    python scripts/evaluate.py [--log PATH] [--db PATH]
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

import pandas as pd
from sklearn.metrics import average_precision_score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from analyst.precompute import DEFAULT_LOG, DEFAULT_OUT, po_number  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", type=Path, default=DEFAULT_LOG)
    ap.add_argument("--db", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    log = pd.read_csv(args.log)
    po_rows = log[log["activity"] == "Create PO"]
    truth = pd.Series(po_rows["trace_label"].values,
                      index=po_rows["doc_ref"].map(po_number), name="truth")
    cases = pd.read_sql("SELECT po, score, flagged, confidence FROM cases",
                        sqlite3.connect(args.db), index_col="po").join(truth)

    y = cases["truth"] != "normal"
    flagged = cases["flagged"] == 1
    tp = (flagged & y).sum()
    print(f"cases {len(cases)}, anomalous {y.sum()}, flagged {flagged.sum()}")
    print(f"precision {tp / flagged.sum():.3f}  recall {tp / y.sum():.3f}  "
          f"score AUPRC (in-sample) {average_precision_score(y, cases['score']):.3f}")
    print("\nrecall by anomaly type:")
    by = cases[y].groupby("truth")["flagged"].agg(["sum", "count"])
    print(by.rename(columns={"sum": "flagged", "count": "total"}).to_string())
    print("\nflagged by confidence (share truly anomalous):")
    print(cases[flagged].groupby("confidence").apply(
        lambda d: f"{(d['truth'] != 'normal').mean():.2f} of {len(d)}",
        include_groups=False).to_string())


if __name__ == "__main__":
    main()
