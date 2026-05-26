"""AIPW shift verification — answers the audit's central question.

Did fixing the shuffled-KFold leak (audit finding F-001, 3-of-3 consensus)
meaningfully change AIPW estimates? This script runs both cross-fitting
strategies side-by-side on the current behavioral matrix and prints a
treatment-by-treatment delta table.

Usage:
    python audit/aipw_shift_check.py [--out audit/aipw_shift.csv]
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import KFold, TimeSeriesSplit  # noqa: F401  (used via patching)

# Add repo root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import causal_inference as ci  # noqa: E402
from hrv_analysis import load_all_data, build_feature_matrix  # noqa: E402


def estimate_aipw_with_kfold(X, T, Y, kfold_factory, n_folds: int = 5):
    """Local copy of estimate_aipw parameterized by the cross-fitting strategy.

    Mirrors ci.estimate_aipw exactly except for the kfold object. Lets us
    swap between TimeSeriesSplit (current) and KFold(shuffle=True) (prior bug).
    """
    from sklearn.linear_model import LogisticRegression, Ridge

    n = len(T)
    if n < n_folds * 4:
        return {"ate": float("nan"), "ci_low": float("nan"),
                "ci_high": float("nan"), "se": float("nan"), "n_used": 0}

    X_std = ci._standardize(X)
    kf = kfold_factory(n_folds)
    psi = np.zeros(n)

    for train_idx, test_idx in kf.split(X_std):
        Xt, Tt, Yt = X_std[train_idx], T[train_idx], Y[train_idx]
        Xv = X_std[test_idx]

        if Tt.sum() < 2 or (Tt == 0).sum() < 2:
            psi[test_idx] = np.nan
            continue

        try:
            ps_model = LogisticRegression(penalty="l2", C=1.0, solver="lbfgs", max_iter=200)
            ps_model.fit(Xt, Tt)
            e = ci._trim_propensity(ps_model.predict_proba(Xv)[:, 1])
            X1, Y1 = Xt[Tt == 1], Yt[Tt == 1]
            X0, Y0 = Xt[Tt == 0], Yt[Tt == 0]
            mu1_model = Ridge(alpha=1.0).fit(X1, Y1)
            mu0_model = Ridge(alpha=1.0).fit(X0, Y0)
            mu1 = mu1_model.predict(Xv)
            mu0 = mu0_model.predict(Xv)
            Tv, Yv = T[test_idx], Y[test_idx]
            psi[test_idx] = (
                mu1 - mu0
                + Tv * (Yv - mu1) / e
                - (1 - Tv) * (Yv - mu0) / (1 - e)
            )
        except Exception:
            psi[test_idx] = np.nan

    psi_valid = psi[~np.isnan(psi)]
    if len(psi_valid) < 10:
        return {"ate": float("nan"), "ci_low": float("nan"),
                "ci_high": float("nan"), "se": float("nan"), "n_used": 0}

    ate = float(psi_valid.mean())
    se = float(psi_valid.std(ddof=1) / np.sqrt(len(psi_valid)))
    return {
        "ate": ate,
        "ci_low": ate - 1.96 * se,
        "ci_high": ate + 1.96 * se,
        "se": se,
        "n_used": int(len(psi_valid)),
    }


def kfold_shuffled(n_folds: int):
    return KFold(n_splits=n_folds, shuffle=True, random_state=42)


def kfold_timeseries(n_folds: int):
    return TimeSeriesSplit(n_splits=n_folds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="audit/aipw_shift.csv",
                        help="Write delta table CSV here (default: audit/aipw_shift.csv)")
    args = parser.parse_args()

    print("Loading data and building feature matrix…")
    t0 = time.time()
    data = load_all_data()
    df = build_feature_matrix(data)

    # Flatten the categories array column the same way hrv_analysis.py does
    supplements = data.get("supplements")

    print(f"  Matrix loaded in {time.time()-t0:.1f}s: {len(df)} rows × {len(df.columns)} cols")

    # Run the causal battery using the SAME enumeration logic as the main pipeline,
    # but capture intermediate (X, T, Y) per treatment so we can re-estimate AIPW
    # with both cross-fitting strategies.
    print("\nEnumerating treatments and running AIPW with both cross-fitting strategies…")

    # Collect treatments via ci.run_causal_battery — but we need access to the
    # per-treatment (X, T, Y) arrays. Easiest: patch ci.estimate_aipw to record
    # them, then post-process.
    captures: list[dict] = []
    original = ci.estimate_aipw

    def capturing_aipw(X, T, Y, **kw):
        result = original(X, T, Y, **kw)  # the production (TimeSeriesSplit) result
        captures.append({"X": X.copy(), "T": T.copy(), "Y": Y.copy(),
                         "ate_tss": result.get("ate"), "ci_low_tss": result.get("ci_low"),
                         "ci_high_tss": result.get("ci_high"), "n_used": result.get("n_used")})
        return result

    ci.estimate_aipw = capturing_aipw
    try:
        results = ci.run_causal_battery(df, supplements=supplements)
    finally:
        ci.estimate_aipw = original

    # The captures list now contains (X, T, Y) for every treatment that survived
    # cell-size gates and ran AIPW. Match them to treatment metadata by order.
    binary_treatments = results.get("binary_treatments", [])
    continuous_treatments = results.get("continuous_treatments", [])
    all_treatments = binary_treatments + continuous_treatments

    if len(captures) != len(all_treatments):
        print(f"WARN: capture/treatment count mismatch ({len(captures)} captures, "
              f"{len(all_treatments)} treatments). Truncating to min.")
    n_pairs = min(len(captures), len(all_treatments))

    print(f"\nRe-estimating AIPW with KFold(shuffle=True) for {n_pairs} treatments…")
    rows = []
    for i in range(n_pairs):
        meta = all_treatments[i]
        cap = captures[i]
        kf_result = estimate_aipw_with_kfold(cap["X"], cap["T"], cap["Y"], kfold_shuffled)
        ate_tss = cap["ate_tss"]
        ate_kf = kf_result.get("ate")
        rows.append({
            "name": meta.get("name") or meta.get("treatment") or f"t{i}",
            "kind": "binary" if i < len(binary_treatments) else "continuous",
            "n_used": cap["n_used"],
            "ate_kfold_shuffled": ate_kf,
            "ate_tss": ate_tss,
            "ate_delta": (ate_tss - ate_kf) if (ate_tss is not None and ate_kf is not None
                                                and not pd.isna(ate_tss) and not pd.isna(ate_kf)) else None,
            "ci_width_kfold": (kf_result.get("ci_high") - kf_result.get("ci_low"))
                              if kf_result.get("ci_high") is not None and kf_result.get("ci_low") is not None else None,
            "ci_width_tss": (cap["ci_high_tss"] - cap["ci_low_tss"])
                            if cap["ci_high_tss"] is not None and cap["ci_low_tss"] is not None else None,
            "sig_kfold": (kf_result.get("ci_low") is not None and kf_result.get("ci_high") is not None
                          and (kf_result["ci_low"] > 0 or kf_result["ci_high"] < 0)),
            "sig_tss":   (cap["ci_low_tss"] is not None and cap["ci_high_tss"] is not None
                          and (cap["ci_low_tss"] > 0 or cap["ci_high_tss"] < 0)),
        })

    df_out = pd.DataFrame(rows)
    df_out["ci_width_delta"] = df_out["ci_width_tss"] - df_out["ci_width_kfold"]
    df_out["sig_flipped"] = df_out["sig_kfold"] != df_out["sig_tss"]

    # Summary
    print("\n" + "=" * 70)
    print("AIPW SHIFT SUMMARY: shuffled-KFold (bugged) vs TimeSeriesSplit (fixed)")
    print("=" * 70)
    print(f"Treatments evaluated:           {len(df_out)}")
    valid = df_out.dropna(subset=["ate_delta"])
    print(f"Treatments with valid deltas:   {len(valid)}")
    if len(valid) > 0:
        print(f"\nATE delta (TSS - KFold) magnitude:")
        print(f"  median |delta|:               {valid['ate_delta'].abs().median():.4f} ms")
        print(f"  mean   |delta|:               {valid['ate_delta'].abs().mean():.4f} ms")
        print(f"  max    |delta|:               {valid['ate_delta'].abs().max():.4f} ms")
        print(f"\nCI width delta (TSS - KFold):")
        print(f"  median delta:                 {valid['ci_width_delta'].median():.4f} ms")
        print(f"  mean   delta:                 {valid['ci_width_delta'].mean():.4f} ms")
        # Negative ci_width_delta means TSS has NARROWER CI than KFold; positive means WIDER.
        # The audit prediction was that shuffled KFold understates SE, so TSS should be WIDER.
        wider = (valid["ci_width_delta"] > 0).sum()
        narrower = (valid["ci_width_delta"] < 0).sum()
        print(f"  TSS wider than KFold:         {wider}/{len(valid)} ({100*wider/len(valid):.1f}%)")
        print(f"  TSS narrower than KFold:      {narrower}/{len(valid)} ({100*narrower/len(valid):.1f}%)")

    print(f"\nSignificance flips:             {df_out['sig_flipped'].sum()} / {len(df_out)}")
    sig_kf_only = df_out[(df_out["sig_kfold"]) & (~df_out["sig_tss"])]
    sig_tss_only = df_out[(~df_out["sig_kfold"]) & (df_out["sig_tss"])]
    print(f"  Significant under KFold only:  {len(sig_kf_only)}  (likely false positives the bug created)")
    print(f"  Significant under TSS only:    {len(sig_tss_only)}  (treatments the bug was masking)")

    if len(sig_kf_only) > 0:
        print(f"\nTop 5 'false-positive' treatments (lost significance after fix):")
        for _, r in sig_kf_only.head(5).iterrows():
            print(f"  {r['name'][:45]:<45} "
                  f"KF ATE={r['ate_kfold_shuffled']:+.2f}ms  TSS ATE={r['ate_tss']:+.2f}ms  "
                  f"Δ={r['ate_delta']:+.2f}ms")

    if len(sig_tss_only) > 0:
        print(f"\nTop 5 newly-significant treatments (the bug had hidden):")
        for _, r in sig_tss_only.head(5).iterrows():
            print(f"  {r['name'][:45]:<45} "
                  f"KF ATE={r['ate_kfold_shuffled']:+.2f}ms  TSS ATE={r['ate_tss']:+.2f}ms  "
                  f"Δ={r['ate_delta']:+.2f}ms")

    # Write CSV
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df_out.to_csv(out_path, index=False)
    print(f"\nFull delta table written to {out_path}")


if __name__ == "__main__":
    main()
