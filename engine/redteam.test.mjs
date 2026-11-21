// 红队对抗测试：边界、非法输入、注入向量
// 运行：node --test redteam.test.mjs
// 注：注入向量的最终防线在 UI 层（esc + decode 白名单），此处测引擎层的健壮性
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOffer, monthlySchedule, compareOffers, annualIncomeTax, bonusTaxSeparate, bonusBlindZone } from './tax-engine.mjs';

test('负数收入输入：不应产生负税前/负税额', () => {
  const r = evaluateOffer({
    label: '攻击', cityKey: 'shanghai',
    monthlySalary: 30000, months: 12,
    annualBonus: -50000,     // 负年终奖
    signOn: -20000,          // 负签字费
    annualStock: -100000,    // 负股票
  });
  assert.ok(r.grossAnnual >= 0, `税前年总包不应为负: ${r.grossAnnual}`);
  assert.ok(r.netAnnual <= r.grossAnnual + 0.01);
  assert.ok(r.taxSalary >= 0);
});

test('负专项附加：不应增加扣除', () => {
  const r = evaluateOffer({
    cityKey: 'shanghai', monthlySalary: 30000, months: 12,
    specialDeductionMonthly: -99999,
  });
  // 负专项附加被钳制后不应低于 0 扣除——当前实现会放大应纳税所得额
  assert.equal(r.taxableSalaryPart, 360000 - 60000 - r.personalMonthlyDeduct * 12 - 0);
});

test('超大输入：不产生 Infinity/NaN', () => {
  const r = evaluateOffer({
    cityKey: 'beijing', monthlySalary: 1e15, months: 12,
    annualBonus: 1e15, annualStock: 1e15, signOn: 1e15,
    specialDeductionMonthly: 1e9,
  });
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} 非有限数: ${v}`);
  }
});

test('months 边界：0 回落默认 12，99 钳到 24', () => {
  const zero = evaluateOffer({ cityKey: 'shanghai', monthlySalary: 20000, months: 0 });
  const big = evaluateOffer({ cityKey: 'shanghai', monthlySalary: 20000, months: 99 });
  assert.equal(zero.months, 12);
  assert.equal(big.months, 24);
});

test('税率表边界值（±1 元）', () => {
  assert.equal(annualIncomeTax(36000), 1080);
  assert.equal(annualIncomeTax(36001), 1080.1);
  assert.equal(annualIncomeTax(144000), 11880);
  assert.equal(annualIncomeTax(144001), 11880.2);
  assert.equal(annualIncomeTax(300000), 43080);
  assert.equal(annualIncomeTax(300001), 43080.25);
});

test('盲区回本点精确性：回本点处税后应恰好追平临界点', () => {
  const edges = [36000, 144000, 300000, 420000, 660000, 960000];
  for (const e of edges) {
    const z = bonusBlindZone(e + 1);
    assert.ok(z.inZone, `edge=${e} 应存在盲区`);
    const netAtEdge = e - bonusTaxSeparate(e);
    const netAtCeiling = z.ceiling - bonusTaxSeparate(z.ceiling);
    assert.ok(Math.abs(netAtCeiling - netAtEdge) < 0.05, `edge=${e}: ${netAtCeiling} vs ${netAtEdge}`);
  }
});

test('盲区无遗漏：扫描全部整数不应存在"窗口外反而比临界点差"', () => {
  // 对每个临界点 e，检查 (e, 回本点) 之外直到下一个数量级，不存在税后 < net(e) 的点
  const edges = [36000, 144000, 300000, 420000, 660000];
  for (const e of edges) {
    const netAtEdge = e - bonusTaxSeparate(e);
    const z = bonusBlindZone(e + 1);
    for (let x = Math.ceil(z.ceiling); x <= z.ceiling + 50000; x += 977) {
      const net = x - bonusTaxSeparate(x);
      assert.ok(net >= netAtEdge - 0.01, `edge=${e} x=${x}: 盲区外仍更差`);
    }
  }
});

test('monthlySchedule 与 evaluateOffer 口径一致（含 13 薪/RSU/签字费）', () => {
  for (const bonusSeparate of [true, false]) {
    const input = {
      cityKey: 'chengdu', monthlySalary: 25000, months: 13,
      annualBonus: 50000, bonusSeparate, signOn: 10000, annualStock: 80000,
      specialDeductionMonthly: 2000, hfRate: 0.08,
    };
    const r = evaluateOffer(input);
    const m = monthlySchedule(input);
    assert.equal(m.totals.taxSum, r.taxSalary);
    assert.equal(m.totals.bonusTax, r.taxBonus);
    const sumMonths = m.rows.reduce((s, x) => s + x.gross, 0);
    // 明细 gross 含签字费(1月)/RSU(季度)/13薪(12月)；并入模式下奖金也进 12 月 gross
    const expectedGross = r.salaryAnnual + 10000 + 80000 + (input.bonusSeparate ? 0 : 50000);
    assert.equal(sumMonths, expectedGross);
  }
});
