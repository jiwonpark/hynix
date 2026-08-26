# 📊 퀀트 트레이딩 모델 평가 프레임워크 (Quantitative Model Evaluation Framework)
> **머신러닝 평가 지표(Accuracy/Precision) vs 트레이딩 백테스팅(PnL/Max DD)의 딜레마와 월가 퀀트 헤지펀드의 2단계 평가론 (Two-Stage Evaluation Architecture)**

---

## 1. 문제의 본질: 머신러닝 vs 금융 트레이딩의 근본적 괴리

데이터 사이언스나 일반 IT 엔지니어링에서 사용되는 표준 분류/회귀 지표(Accuracy, Precision, Recall, F1-Score, MSE)를 금융 모델에 그대로 대입하면 **"모델 승률은 70%인데 실제 계좌는 깡통을 차는 파멸(Accuracy Paradox)"**이 일어납니다. 반대로, 어떤 우수한 추세추종(Trend Following CTA) 펀드는 **승률이 35%에 불과한데도 매년 수백억 원의 막대한 순이익**을 냅니다.

이 괴리는 금융 시장 특유의 3가지 본질적 속성에서 기인합니다:

### ① 손익 비대칭성 (Payoff Asymmetry & Magnitude Blindness)
* **일반 ML 지표의 맹점**: $+0.05\%$ 상승을 맞힌 것과, $+6.0\%$ 폭등을 맞힌 것을 **똑같이 1회의 맞힘(True Positive)**으로 취급합니다.
* **트레이딩의 현실**: 9번을 $+0.2\%$씩 맞히고(승률 90%), 1번을 $-5.0\%$ 틀리면(패율 10%), 정확도는 **90%**이지만 계좌는 **$-3.2\%$ 적자**로 파산합니다.
* **핵심 원칙**: 트레이딩은 **"얼마나 자주 맞히는가(Hit Ratio)"**가 아니라, **"맞았을 때 얼마를 벌고, 틀렸을 때 얼마를 잃는가(Payoff Ratio = Avg Win / Avg Loss)"**의 문제입니다.

### ② 거래 마찰 비용 (Transaction Friction: Fee, Slippage, Funding)
* 통계적으로 55%의 방향성 예측 정확도를 지닌 완벽한 모델이라도, 진입/청산 시 발생하는 **왕복 거래 수수료(5~10 BPS)**, **호가 슬리피지(Slippage)**, 그리고 무기한 선물의 **일일 펀딩비(Funding Cost)**를 제하고 나면 순 엣지(Net Alpha)는 마이너스가 됩니다.
* 일반 ML 손실 함수(Loss Function)는 이 마찰 비용을 전혀 인지하지 못합니다.

### ③ 경로 의존성 및 자본 파멸 리스크 (Path Dependency & Margin Ruin)
* Precision이나 MSE는 시점별 정답 여부만 독립적으로(Cross-sectionally) 평가합니다.
* 하지만 레버리지 선물 트레이딩은 **계좌 잔고가 시간에 따라 연속적으로 이어지는 경로 의존적(Path-Dependent) 프로세스**입니다.
* 모델의 24시간 후 예측이 맞더라도, 중간 3시간 동안 스프레드가 일시적으로 급격히 벌어져 계좌 잔고가 **강제 청산(Margin Call)** 임계선에 도달하면, 모델의 최종 적중 여부와 상관없이 게임은 즉시 끝납니다.

---

## 2. 그렇다면 "처음부터 PnL과 Max DD로만 모델을 튜닝"하면 되는가?

"그렇다면 복잡한 ML 지표를 버리고, 처음부터 백테스트 수익률(PnL)과 최대 낙폭(Max DD)만 보면서 모델 파라미터를 맞추면 되지 않는가?"라는 의문이 생깁니다.

그러나 이것은 퀀트 역사상 가장 많은 자금을 날린 치명적인 함정인 **과최적화의 지옥(The Overfitting & P-Hacking Trap)**으로 직결됩니다:

1. **데이터 스누핑 편향 (Data Snooping / Curve-Fitting)**:
   * 금융 시계열 데이터의 95% 이상은 순수 무작위 노이즈(Noise)입니다.
   * 복잡한 모델의 내부 파라미터를 최종 PnL에만 맞춰 역전파(Backpropagation)하거나 그리드 탐색하면, 모델은 **"과거 특정 날짜의 우연한 가격 튐"**을 외워버립니다.
   * 백테스트에서는 연 $+500\%$가 나오지만, 실전 라이브에 올리자마자 지속적으로 우하향하는 전형적인 이유입니다.
2. **원인과 결과의 혼재 (Confounding Signal with Sizing/Luck)**:
   * PnL이 높게 나온 것이 **"순수 예측력(Alpha Signal)"**이 우수해서인지, 아니면 우연히 시장 추세가 좋았거나 레버리지를 높게 베팅한 **"단순 베타/운(Execution Timing)"**이었는지 분리하여 검증할 수 없습니다.

---

## 3. 월가 퀀트 헤지펀드의 표준 해법: 2단계 평가 아키텍처 (Two-Stage Evaluation)

탑티어 퀀트(AQR, Two Sigma, Renaissance Technologies, Citadel 등)는 이 딜레마를 해결하기 위해 **평가 과정을 2단계로 완전히 분리**합니다.

```
+-----------------------------------------------------------------------------------------+
| [ Stage 1: 알파 신호 검증 (Alpha Signal Layer) ]                                        |
|  - 목표: 시장 노이즈를 뚫고 순수한 미래 가격 예측 정보(Edge)가 존재하는가?              |
|  - 지표: Information Coefficient (IC), Rank IC, Volatility-Weighted Edge, Brier Score   |
+-----------------------------------------------------------------------------------------+
                                      │
                                      │ (Stage 1 통과 모델만 진입)
                                      ▼
+-----------------------------------------------------------------------------------------+
| [ Stage 2: 트레이딩 실행 및 자산 배분 (Portfolio Execution Layer) ]                     |
|  - 목표: 검증된 예측 신호를 수수료/슬리피지를 감내하며 레버리지로 어떻게 돈으로 바꿀 것인가? |
|  - 지표: Calmar Ratio, Purged Walk-Forward PnL, Profit Factor, Max Drawdown (MDD)       |
+-----------------------------------------------------------------------------------------+
```

---

### [Stage 1] 알파 신호 계층 (Alpha Signal Evaluation)
> 트레이딩 규칙(레버리지, 익절선 등)을 떼어내고, **"모델의 예측이 미래 가격 변화와 통계적으로 유의미한 상관관계를 가지는가?"**만을 검증합니다.

1. **정보 계수 (Information Coefficient, IC & Rank IC)**:
   * 모델의 시계열 예측치 $\hat{y}_{t+h}$와 실제 실현 수익률 $r_{t+h}$ 간의 스피어만 순위 상관계수(Spearman's Rank Correlation).
   \[
   \text{Rank IC} = \text{Corr}\big(\text{Rank}(\hat{y}_{t+h}), \text{Rank}(r_{t+h})\big)
   \]
   * **기준**: 금융 시계열에서는 일일 캔들 기준 $\text{IC} > 0.03 \sim 0.05$만 지속되어도 최상위 퀀트 펀드급의 강력한 알파로 평가합니다.
2. **변동성 정규화 기대 엣지 (Volatility-Adjusted Edge)**:
   * 단순히 맞고 틀림이 아니라, $\text{예측 방향} \times \text{스프레드 변동폭}$을 시장 변동성 $\sigma$로 나눈 값:
   \[
   \text{Norm Edge} = \mathbb{E}\left[ \text{sign}(\hat{y}_{t+h} - y_t) \cdot \frac{y_{t+h} - y_t}{\sigma_t} \right]
   \]
3. **확률적 신뢰도 캘리브레이션 (Brier Score / Log Loss for Regimes)**:
   * HMM(은닉 마르코프 모델) 등에서 "평균회귀 국면 확률이 80%"라고 예측했다면, 실제로 그 시점들 중 80%가 평균회귀했는지 측정.

---

### [Stage 2] 전략 실행 및 자산 배분 계층 (Portfolio & Execution Evaluation)
> Stage 1을 통과한 순수 알파 신호에 **거래 비용(수수료/슬리피지), 진입 임계치(Threshold), 레버리지(Leverage), 리밸런싱 속도(Pacing)**를 결합하여 실제 포트폴리오 성과를 평가합니다.

1. **칼마 비율 (Calmar Ratio) — 단순 PnL보다 10배 중요한 지표**:
   \[
   \text{Calmar Ratio} = \frac{\text{연환산 복리 수익률 (CAGR)}}{|\text{최대 낙폭 (Maximum Drawdown)}|}
   \]
   * **이유**: Max DD가 $-3\%$이면서 연 $+30\%$를 버는 전략은, 레버리지를 2배 쓰면 Max DD $-6\%$에 연 $+60\%$가 됩니다. 반면 Max DD가 $-40\%$이면서 연 $+60\%$인 전략은 레버리지를 조금만 잘못 써도 계좌가 청산됩니다. 따라서 퀀트는 단순 PnL이 아니라 **낙폭 대비 수익률(Calmar)**을 극대화합니다.
2. **비용 차감 후 순 수익 계수 (Profit Factor after Friction)**:
   \[
   \text{Profit Factor} = \frac{\text{총 총이익 (Gross Profit)}}{\text{총 총손실 (Gross Loss)} + \text{총 수수료 및 슬리피지}}
   \]
   * 비용을 모두 차감하고도 $1.5$ 이상을 안정적으로 유지해야 실전 배포가 가능합니다.
3. **Purged Walk-Forward Cross-Validation (WFA)**:
   * 과거 70% 구간(In-Sample)에서 찾은 최적 파라미터가, 전혀 본 적 없는 미래 30% 구간(Out-of-Sample / Holdout)에서도 플러스 수익과 안정적인 Max DD를 유지하는지 검증합니다.

---

## 4. SK하이닉스 무기한물 차익거래 시스템의 아키텍처 매핑

본 시스템(SK Hynix Arb Quant Engine)은 이 2단계 프레임워크를 완벽하게 분리하여 구현하고 있습니다:

| 계층 구분 | 대시보드 컴포넌트 | 평가 대상 및 수학적 지표 | 실무적 의미 |
| :--- | :--- | :--- | :--- |
| **Stage 1<br>(신호 알파 엔진)** | `파동 예측 엔진`<br>(Medallion HMM, Ridge OLS, OU Hybrid, Burg, DFT) | • 예측 신뢰도 (Confidence %)<br>• 괴리율 엣지 (Edge %)<br>• 인과적 잔차 오차 (Causal Residual) | **"시장 왜곡이 진실인가, 가짜 노이즈인가?"**<br>과거 24h 인과적 데이터만으로 미래 24h 파동을 순수 통계적으로 추정. |
| **Stage 2<br>(실행 및 백테스트)** | `알고리즘 자동 최적화기`<br>(Mean bars, Edge Band, Max Size, Speed, Fee) | • 누적 수익률 (Acc PnL %)<br>• 최대 낙폭 (Max DD %)<br>• 3-Fold Walk-Forward 점수<br>• 순 엣지 (Net Edge after fees) | **"이 신호로 어떻게 안전하게 돈을 벌 것인가?"**<br>수수료(5 BPS), 펀딩비(3 BPS/day), 레버리지(1~5x)를 감안한 최적 주문 및 리밸런싱 곡선 도출. |

---

## 5. 실전 퀀트 연구 및 배포 체크리스트 (Workflow Summary)

새로운 매매 아이디어나 머신러닝 모델을 도입할 때는 반드시 아래의 순서를 따릅니다:

1. [ ] **신호 독립성 검증**: 트레이딩 룰 없이, 모델 예측값과 미래 스프레드 변화 간의 **Rank IC가 최소 $+0.03$ 이상** 나오는가?
2. [ ] **마찰 비용 여유분 확인**: 모델의 평균 기대 엣지가 **왕복 거래 수수료 + 슬리피지 합산(최소 10~15 BPS)의 3배 이상**인가?
3. [ ] **손익비(Payoff Ratio) 검토**: 정확도(Accuracy)에 집착하지 말고, 평균 이익/평균 손실 비율이 최소 $1.3$ 이상인가?
4. [ ] **자본 보존성(Calmar) 평가**: 레버리지 $3\text{x}\sim5\text{x}$ 적용 시 백테스트 전 기간에 걸쳐 **Max DD가 $-10\%$ 이내**로 방어되는가?
5. [ ] **Out-of-Sample Walk-Forward 통과**: 최적화 파라미터가 학습에 쓰이지 않은 최근 홀드아웃(Holdout) 구간에서도 양호한 양(+)의 폴드 점수를 기록하는가?
6. [ ] **실전 배포(Deploy)**: 위의 단계를 통과한 파라미터 세트만 **[ 🚀 Deploy Strategy to Trading Bot ]** 버튼을 통해 실전 터미널에 반영.
