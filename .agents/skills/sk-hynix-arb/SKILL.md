---
name: sk-hynix-arb
description: >-
  Quantitative arbitrage engine and real-time forecasting suite for dual-listed
  SK Hynix (SKHYNIXUSDT Korean domestic vs SKHYUSDT US OTC ADR). Covers market data
  alignment, 6 predictive wave engines (Medallion HMM, Multi-Scale Ridge OLS, OU Hybrid,
  Burg MEM, Sparse DFT, Multi-Horizon), Calmar risk-adjusted leverage optimization,
  and zero-downtime EC2 deployment workflows.
---

# SK Hynix Dual-Listed Arbitrage & Predictive Analytics Engine

This skill encapsulates the complete quantitative model architecture, backtesting equations, news catalyst correlation feed, and production deployment protocols for the SK Hynix synthetic arbitrage platform.

---

## 1. Quantitative Foundations & Market Mechanics

### Structural Parity Definition
The corporate ratio mandates that 1 ADR unit is backed by 0.1 underlying Korean shares:
$$\text{Fair ADR (USDT)} = \frac{\text{SK Hynix (KRW)}}{10 \times \text{USD/KRW FX}}$$

On Binance Futures (`SKHYUSDT` vs `SKHYNIXUSDT`), the normalized spread tracks the percentage valuation:
$$\text{Normalized Spread} = \left( \frac{\text{SKHYUSDT}}{\text{SKHYNIXUSDT}} \right) \times 100$$
- **Spread $> \text{Mean}$**: ADR is expensive $\rightarrow$ **Short ADR / Long Korea** (displayed as **Red $\blacktriangledown$**).
- **Spread $< \text{Mean}$**: ADR is cheap $\rightarrow$ **Long ADR / Short Korea** (displayed as **Green $\blacktriangle$**).

---

## 2. The 6 Quantitative Prediction Engines

All models operate strictly **causally** (zero lookahead / hindsight bias). The prediction plotted at historical timestamp $T$ represents $\hat{y}_{T|T-24\text{h}}$ calculated using data strictly up to $T - 24\text{h}$.

### Engine 1: Medallion Regime-Switching HMM
- Computes return volatility and autocorrelation of spread increments $\rho_1 = \text{Corr}(\Delta x_t, \Delta x_{t-1})$.
- Determines regime transition probability $P(\text{Reversion}) = \text{clamp}(0.5 - 1.2 \rho_1, 0.15, 0.95)$.
- Conditionally scales mean reversion: $\hat{y}(t+s) = P_t + \big(\hat{y}_{\text{OU}}(t+s) - P_t\big) \cdot P(\text{Reversion})$.

### Engine 2: Multi-Scale Moving Average Cascade (Ridge OLS)
- Extracts multi-scale momentum kernels: $\text{MA}_4, \text{MA}_8, \text{MA}_{16}, \text{MA}_{32}$ relative to $\text{MA}_{64}$ baseline.
- Solves regularized normal equations dynamically on lookback slice:
  $$\mathbf{w}^* = (\mathbf{X}^T \mathbf{X} + \lambda \mathbf{I})^{-1} \mathbf{X}^T \mathbf{Y} \quad (\lambda = 0.05)$$
- Projects trajectory using optimal weights: $\hat{y}(t+s) = \text{Base}_t + \sum w_k^* (\text{MA}_k - \text{Base}) e^{-s/\tau_k}$.

### Engine 3: Ornstein-Uhlenbeck (OU) + Adaptive Harmonic Hybrid
- Calibrates continuous SDE $dx_t = \theta(\mu - x_t)dt + \sigma dW_t$ via discrete AR(1) regression.
- Overlays top 4 harmonic cycles: $\hat{y}(t+s) = \mathbb{E}[x_{t+s}] + 0.65 \sum A_k e^{-\lambda s} \cos\big( \frac{2\pi k (n+s)}{M} + \phi_k \big)$.

### Engine 4: Burg Maximum Entropy Method (Spectral AR Lattice)
- Fits all-pole autoregressive reflection coefficients $k_m$ by minimizing forward/backward prediction error energy without windowing distortion.

### Engine 5: Multi-Horizon Ensemble
- Committee blend across multiple time scales:
  $$\hat{y}(t+s) = 0.30 \hat{y}(t, 0.25s) + 0.30 \hat{y}(t, 0.50s) + 0.25 \hat{y}(t, s) + 0.15 \hat{y}_{\text{Burg}}(t, s)$$

### Engine 6: Sparse Discrete Fourier Decomposition (DFT)
- Extracts top 4 dominant spectral power peaks $P_k = \text{Re}^2 + \text{Im}^2$ with exponential relaxation envelope $e^{-s / 288}$.

---

## 3. Risk-Adjusted Leverage & Inventory Optimization

### Dollar-Weighted Cumulative Inventory Accounting
$$\text{Cost Basis}_{\text{new}} = \frac{Q_{\text{prev}} \cdot \text{Cost Basis}_{\text{prev}} + Q_{\text{add}} \cdot P_{\text{now}}}{Q_{\text{prev}} + Q_{\text{add}}}$$
- Trimming/reducing position does not alter remaining inventory cost basis.
- Flat position resets cost basis to `null`.

### Calmar / Sharpe Optimization Metric
The optimizer searches across leverage parameters ($1\text{x}$ to $5\text{x}$), scale curves, and take-profit thresholds:
$$\text{Score} = \frac{\text{Net Return}}{\left( \max(0.5, |\text{Max Drawdown}|) \right)^{0.75}}$$

---

## 4. Quantitative Model Evaluation Framework: ML Metrics vs Trading Backtest (Two-Stage Architecture)

A fundamental principle in institutional quant trading is separating **Alpha Signal Evaluation** from **Execution & Portfolio Evaluation**. Relying solely on conventional ML metrics (Accuracy, Precision, Recall) causes the **Accuracy Paradox** (e.g. 90% hit rate with small gains wiped out by a single fat-tail loss, or positive accuracy wiped out by 10 BPS transaction fees and funding drag). Conversely, optimizing model weights directly against backtest PnL causes catastrophic **overfitting & data snooping (p-hacking)**.

### The 2-Stage Evaluation Pipeline:
1. **Stage 1: Statistical Alpha Metric (Signal Validation)**:
   - Evaluates whether the model possesses genuine predictive power over future price changes without trade rules:
     - **Information Coefficient (Rank IC)**: Spearman rank correlation between $\hat{y}_{t+h}$ and realized $r_{t+h}$ ($\text{IC} > 0.03$ is institutional-grade).
     - **Volatility-Normalized Edge**: $\mathbb{E}[\text{sign}(\Delta \hat{y}) \cdot \Delta y / \sigma]$.
     - **Regime Calibration**: Brier score / log-loss for HMM regime transitions.
2. **Stage 2: Execution & Sizing Optimization (Strategy Backtest)**:
   - Evaluates how to monetize the validated signal under real-world market frictions (5 BPS fee, 3 BPS funding, leverage):
     - **Calmar Ratio**: $\text{CAGR} / |\text{Max Drawdown}|$ (penalizes tail risk and capital ruin).
     - **Profit Factor after Costs**: $\text{Gross Profit} / (\text{Gross Loss} + \text{Fees} + \text{Slippage}) \ge 1.5$.
     - **Purged Walk-Forward Cross-Validation (WFA)**: Ensuring positive fold efficiency on untouched holdout data.

*For complete theoretical formulation, see [QUANT_MODEL_EVALUATION_GUIDE.md](file:///Users/jiwon/Documents/hynix/QUANT_MODEL_EVALUATION_GUIDE.md).*

---

## 5. Standard UI Color Hierarchy

To preserve clarity across analytical series:
- **Spot Spread Price**: `Solid Black (#0f172a)`
- **Rolling +24h Prediction Wave**: `Cyan (#00d2ff)`
- **Long ADR Positions**: `Green (#16a34a)` (▲ Rises above 0 baseline)
- **Short ADR Positions**: `Red (#dc2626)` (▼ Descends below 0 baseline)
- **Macro Cycles & Size Bands**: `Slate Gray (#64748b)` and `Light Gray (#cbd5e1)`

---

## 6. Deployment Runbook (Zero-Downtime EC2 Protocol)

When making modifications or adding new features to `/Users/jiwon/Documents/hynix/index.html`:

```bash
# 1. Verify working directory
cd /Users/jiwon/Documents/hynix

# 2. Deploy updated single-file bundle to EC2
scp /Users/jiwon/Documents/hynix/index.html thejiwon2025:/tmp/index.html && \
ssh thejiwon2025 "sudo cp /tmp/index.html /var/www/skhynix/index.html"

# 3. Commit and push to GitHub repository
git add index.html
git commit -m "Describe updates"
git push origin main
```

**Production URL**: `https://control.jiwonova.com/skhynix/`
