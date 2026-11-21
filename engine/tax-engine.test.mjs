// 税薪引擎单元测试 —— 所有期望值均为手算得出，手算过程写在断言旁
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annualIncomeTax, bonusTaxSeparate, bonusBlindZone,
  evaluateOffer, compareOffers, monthlySchedule,
} from './tax-engine.mjs';

test('综合所得年度税率表（速算扣除数法）', () => {
  assert.equal(annualIncomeTax(36000), 1080);        // 36000×3%
  assert.equal(annualIncomeTax(144000), 11880);      // 1080 + 108000×10%
  assert.equal(annualIncomeTax(300000), 43080);      // 11880 + 156000×20%
  assert.equal(annualIncomeTax(420000), 73080);      // 420000×25%−31920
  assert.equal(annualIncomeTax(660000), 145080);     // 660000×30%−52920
  assert.equal(annualIncomeTax(960000), 250080);     // 960000×35%−85920
  assert.equal(annualIncomeTax(1000000), 268080);    // 1000000×45%−181920
  assert.equal(annualIncomeTax(0), 0);
  assert.equal(annualIncomeTax(-5000), 0);
});

test('年终奖单独计税', () => {
  assert.equal(bonusTaxSeparate(0), 0);
  assert.equal(bonusTaxSeparate(36000), 1080);       // 36000/12=3000 → 3%
  assert.equal(bonusTaxSeparate(36001), 3390.1);     // 跳档：36001×10%−210
  assert.equal(bonusTaxSeparate(60000), 5790);       // 5000/月 → 10%档：60000×10%−210
  assert.equal(bonusTaxSeparate(144000), 14190);     // 12000/月 → 仍10%档（"至12000"含边界）：14400−210
  assert.equal(bonusTaxSeparate(144001), 27390.2);   // 跳档：144001×20%−1410
});

test('年终奖盲区检测', () => {
  const z = bonusBlindZone(37000);
  assert.equal(z.inZone, true);
  assert.equal(z.edge, 36000);
  assert.equal(z.ceiling, 38566.67);                 // (36000×0.97−210)/0.9
  assert.equal(z.suggest, 36000);
  assert.equal(z.lost, 1410);                        // 34920 − (37000×0.9+210=33510)
  assert.equal(bonusBlindZone(36000).inZone, false);
  assert.equal(bonusBlindZone(38566.67).inZone, false);
  assert.equal(bonusBlindZone(50000).inZone, false); // 高于回本点
});

test('完整 offer：上海 30k×12+60k 年终奖，单独计税', () => {
  const r = evaluateOffer({
    label: 'A公司', cityKey: 'shanghai',
    monthlySalary: 30000, months: 12, annualBonus: 60000,
    specialDeductionMonthly: 3000, hfRate: 0.07,
  });
  // 社保基数 30000（在 7384–36921 内不缩放）
  assert.equal(r.socialBase, 30000);
  assert.equal(r.personalSI, 3150);                  // 30000×10.5%
  assert.equal(r.personalHF, 2100);                  // 30000×7%
  // 应纳税所得额 = 360000 − 60000 − 5250×12 − 3000×12 = 201000
  assert.equal(r.taxableSalaryPart, 201000);
  assert.equal(r.taxSalary, 23280);                  // 201000×20%−16920
  assert.equal(r.taxBonus, 5790);                    // 60000×10%−210（月均5000在10%档）
  assert.equal(r.personalTotal, 63000);
  assert.equal(r.grossAnnual, 420000);
  assert.equal(r.netAnnual, 327930);                 // 420000−63000−23280−5790
  assert.equal(r.netMonthlyAvg, 27327.5);
  // 公司口径：30000×25.76% = 7728；+公积金 2100 → 年成本 420000+117936
  assert.equal(r.employerCostAnnual, 537936);
});

test('同一 offer 年终奖并入综合所得（对照）', () => {
  const r = evaluateOffer({
    label: 'A公司并入', cityKey: 'shanghai',
    monthlySalary: 30000, months: 12, annualBonus: 60000, bonusSeparate: false,
    specialDeductionMonthly: 3000, hfRate: 0.07,
  });
  // 应纳税所得额 = 201000+60000 = 261000 → ×20%−16920 = 35280
  assert.equal(r.taxSalary, 35280);
  assert.equal(r.taxBonus, 0);
  assert.equal(r.netAnnual, 321720);                 // 420000−63000−35280
});

test('社保基数上下限缩放', () => {
  const low = evaluateOffer({ cityKey: 'shanghai', monthlySalary: 5000, months: 12 });
  assert.equal(low.socialBase, 7546);                // 触下限（2026 官方值）
  const high = evaluateOffer({ cityKey: 'shanghai', monthlySalary: 80000, months: 12 });
  assert.equal(high.socialBase, 37731);              // 触上限（2026 官方值）
});

test('13薪与签字费、股票', () => {
  const r = evaluateOffer({
    cityKey: 'hangzhou', monthlySalary: 20000, months: 13,
    signOn: 20000, annualStock: 100000, annualBonus: 0,
    specialDeductionMonthly: 1000, hfRate: 0.12,
  });
  // 社保基数 20000（4462–24930 内）
  assert.equal(r.socialBase, 20000);
  assert.equal(r.personalSI, 2100);                  // 20000×10.5%
  assert.equal(r.personalHF, 2400);                  // 20000×12%
  // 工资侧 = 20000×13 + 20000 + 100000 − 60000 − (2100+2400)×12 − 1000×12
  //        = 380000 − 60000 − 54000 − 12000 = 254000
  assert.equal(r.taxableSalaryPart, 254000);
  assert.equal(r.taxSalary, 33880);                  // 254000 落 20% 档：50800−16920
  assert.equal(r.grossAnnual, 380000);
  assert.equal(r.netAnnual, 380000 - 54000 - 33880); // = 292120
});

test('多 offer 对比排序', () => {
  const [best, ...rest] = compareOffers([
    { label: '低', cityKey: 'shanghai', monthlySalary: 15000, months: 12, annualBonus: 30000 },
    { label: '高', cityKey: 'shanghai', monthlySalary: 30000, months: 12, annualBonus: 60000 },
    { label: '中', cityKey: 'shanghai', monthlySalary: 20000, months: 14, annualBonus: 20000 },
  ]);
  assert.equal(best.label, '高');
  assert.ok(rest.every((r) => r.netAnnual <= best.netAnnual));
});

test('北京医疗固定附加3元', () => {
  const r = evaluateOffer({ cityKey: 'beijing', monthlySalary: 20000, months: 12 });
  assert.equal(r.socialBase, 20000);
  assert.equal(r.personalSI, 2103);                  // 20000×10.5% + 3
  // 税前扣除口径不含3元：deduct = 2103−3+2400 = 4500
  assert.equal(r.personalMonthlyDeduct, 4500);
  // 实缴口径含3元：personalTotal = (2103+2400)×12
  assert.equal(r.personalTotal, 54036);
});

// ---- v2：逐月累计预扣 + 不变量 ----

test('逐月明细：上海示例手算 + 与年度口径一致', () => {
  const input = {
    label: 'A', cityKey: 'shanghai', monthlySalary: 30000, months: 12,
    annualBonus: 60000, specialDeductionMonthly: 3000, hfRate: 0.07,
  };
  const r = evaluateOffer(input);
  const m = monthlySchedule(input);
  // 1月：30000 − 5000 − 5250 − 3000 = 16750 → 3% = 502.50
  assert.equal(m.rows[0].gross, 30000);
  assert.equal(m.rows[0].cumTaxable, 16750);
  assert.equal(m.rows[0].cumTax, 502.5);
  assert.equal(m.rows[0].tax, 502.5);
  // 12月：累计应纳税所得额 201000、累计税 23280，与年度口径完全一致
  assert.equal(m.rows[11].cumTaxable, 201000);
  assert.equal(m.rows[11].cumTax, 23280);
  assert.equal(m.totals.taxSum, r.taxSalary);
  assert.equal(m.totals.bonusTax, 5790);
  assert.equal(m.rows[11].bonusTax, 5790);           // 年终奖税落在12月单列
  // 逐月税额合计 = 年度税额（累计预扣法的性质）
  const sumMonths = m.rows.reduce((s, x) => s + x.tax, 0);
  assert.equal(Math.round(sumMonths * 100) / 100, 23280);
});

test('逐月明细：13薪计入12月、签字费计入1月、RSU按季度', () => {
  const input = {
    cityKey: 'hangzhou', monthlySalary: 20000, months: 13,
    signOn: 20000, annualStock: 100000, annualBonus: 0,
    specialDeductionMonthly: 1000, hfRate: 0.12,
  };
  const r = evaluateOffer(input);
  const m = monthlySchedule(input);
  assert.equal(m.rows[0].gross, 40000);              // 月薪20000 + 签字费20000
  assert.equal(m.rows[2].gross, 45000);              // + RSU 25000（季度）
  assert.equal(m.rows[11].gross, 65000);             // 20000 + RSU 25000 + 13薪20000
  assert.equal(m.totals.taxSum, r.taxSalary);        // 33880，与年度口径一致
});

test('盲区性质：临界点税后 ≥ 盲区内任意金额税后（暴力验证）', () => {
  // 公开可查的经典盲区边界值（多方口径一致）
  const expectedCeilings = { 36000: 38566.67, 144000: 160500, 300000: 318333.33, 420000: 447500, 660000: 706538.46 };
  const edges = [36000, 144000, 300000, 420000, 660000];
  for (const e of edges) {
    const netAtEdge = e - bonusTaxSeparate(e);
    const z = bonusBlindZone(e + 1);
    assert.equal(z.inZone, true);
    assert.equal(z.ceiling, expectedCeilings[e], `edge=${e} 的盲区上限`);
    // 在盲区内暴力采样，临界点处税后必须最高
    for (let x = e + 1; x < z.ceiling; x += 1111) {
      const netHere = x - bonusTaxSeparate(x);
      assert.ok(netAtEdge >= netHere - 0.01, `edge=${e} x=${x}: ${netAtEdge} < ${netHere}`);
    }
    // 盲区上限处（回本点）税后恰好追平临界点
    const netAtCeiling = z.ceiling - bonusTaxSeparate(z.ceiling);
    assert.ok(Math.abs(netAtCeiling - netAtEdge) < 0.02, `edge=${e} 回本点未追平`);
  }
});

test('不变量：税后 ≤ 税前、公司成本 ≥ 税前、税率单调', () => {
  const samples = [
    { cityKey: 'shenzhen', monthlySalary: 8000, months: 12, annualBonus: 20000 },
    { cityKey: 'guangzhou', monthlySalary: 25000, months: 14, annualBonus: 80000, annualStock: 200000 },
    { cityKey: 'other', monthlySalary: 300000, months: 16, annualBonus: 500000, signOn: 300000 },
    { cityKey: 'beijing', monthlySalary: 0, months: 12 },
  ];
  for (const s of samples) {
    const r = evaluateOffer(s);
    assert.ok(r.netAnnual <= r.grossAnnual + 0.01, JSON.stringify(s));
    assert.ok(r.employerCostAnnual >= r.grossAnnual - 0.01);
    assert.ok(r.taxSalary >= 0 && r.taxBonus >= 0);
  }
  // 工资为 0 的极端输入不炸（数学上五险一金照缴故为负，现实不存在该输入）
  const zero = evaluateOffer(samples[3]);
  assert.ok(zero.netAnnual <= 0);
  // 税额对应纳税所得额单调不减
  let prev = 0;
  for (let t = 0; t <= 1200000; t += 1000) {
    const cur = annualIncomeTax(t);
    assert.ok(cur >= prev - 0.011, `税额在 t=${t} 处下降`);
    prev = cur;
  }
});

test('广州 2026 基数（官方公告口径）', () => {
  const r = evaluateOffer({ cityKey: 'guangzhou', monthlySalary: 5000, months: 12 });
  assert.equal(r.socialBase, 5510);                  // 触下限（广州市、省直口径）
  const high = evaluateOffer({ cityKey: 'guangzhou', monthlySalary: 60000, months: 12 });
  assert.equal(high.socialBase, 27549);              // 触上限
});

test('逐月明细：并入模式下奖金进12月税基，与年度口径一致', () => {
  const input = {
    label: 'M', cityKey: 'shanghai', monthlySalary: 30000, months: 12,
    annualBonus: 60000, bonusSeparate: false, specialDeductionMonthly: 3000, hfRate: 0.07,
  };
  const r = evaluateOffer(input);                    // 税后 321,720（并入）
  const m = monthlySchedule(input);
  assert.equal(m.totals.taxSum, r.taxSalary);        // 35280，两种口径一致
  assert.equal(m.totals.bonusTax, 0);
  assert.equal(m.rows[11].gross, 90000);             // 30000 工资 + 60000 奖金
  assert.equal(m.rows[11].cumTaxable, 261000);       // 201000 + 60000
});

test('西安 2026 基数（陕西省级统筹）', () => {
  const r = evaluateOffer({ cityKey: 'xian', monthlySalary: 4000, months: 12 });
  assert.equal(r.socialBase, 4737);                  // 触下限
  const high = evaluateOffer({ cityKey: 'xian', monthlySalary: 60000, months: 12 });
  assert.equal(high.socialBase, 23685);              // 触上限
});

test('天津 2026 基数（津人社局发〔2026〕5号）', () => {
  const r = evaluateOffer({ cityKey: 'tianjin', monthlySalary: 5000, months: 12 });
  assert.equal(r.socialBase, 5180);                  // 触下限
  const high = evaluateOffer({ cityKey: 'tianjin', monthlySalary: 50000, months: 12 });
  assert.equal(high.socialBase, 25902);              // 触上限
});

test('长沙 2026 基数（湖南省级统筹）', () => {
  const r = evaluateOffer({ cityKey: 'changsha', monthlySalary: 4000, months: 12 });
  assert.equal(r.socialBase, 4106);                  // 触下限
  const high = evaluateOffer({ cityKey: 'changsha', monthlySalary: 50000, months: 12 });
  assert.equal(high.socialBase, 20529);              // 触上限
});

test('合肥/济南 2026 基数（官方文号）', () => {
  const hf = evaluateOffer({ cityKey: 'hefei', monthlySalary: 4000, months: 12 });
  assert.equal(hf.socialBase, 4354);
  const hfHigh = evaluateOffer({ cityKey: 'hefei', monthlySalary: 60000, months: 12 });
  assert.equal(hfHigh.socialBase, 21772);
  const jn = evaluateOffer({ cityKey: 'jinan', monthlySalary: 4000, months: 12 });
  assert.equal(jn.socialBase, 4573);
  const jnHigh = evaluateOffer({ cityKey: 'jinan', monthlySalary: 60000, months: 12 });
  assert.equal(jnHigh.socialBase, 22863);
});
