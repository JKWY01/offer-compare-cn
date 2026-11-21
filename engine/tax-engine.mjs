// ============================================================
// 税薪计算引擎（Offer 对比核心逻辑）
// 纯函数、无依赖，可被 Node 测试，也可内联进浏览器页面。
//
// 建模假设（页面会向用户说明）：
//   - 全年在职 12 个月（年中入职的汇算差异不在本工具范围内）
//   - 五险一金按 12 个月缴纳；months 仅表示"工资发放月数"（12薪/13薪/14薪）
//   - RSU 股票按工资薪金累计计税；期权行权同理简化处理
//
// 常数标注规则：
//   SRC: VERIFIED(<url>) —— 已核实到官方/可靠来源
//   SRC: PENDING-VERIFY  —— 凭通识写入，发布前必须核实
// ============================================================

// ---- 个税综合所得年度税率表（2019 修法后至今未变） ----
// SRC: VERIFIED 个人所得税法（总局法规库）https://fgk.chinatax.gov.cn/zcfgk/c100009/c5193028/content.html
//      税率表官方 PDF（上海税务局）https://shanghai.chinatax.gov.cn/zcfw/zcfgk/grsds/202402/P020240202362406243753.pdf
export const ANNUAL_BRACKETS = [
  { limit: 36000, rate: 0.03, quick: 0 },
  { limit: 144000, rate: 0.10, quick: 2520 },
  { limit: 300000, rate: 0.20, quick: 16920 },
  { limit: 420000, rate: 0.25, quick: 31920 },
  { limit: 660000, rate: 0.30, quick: 52920 },
  { limit: 960000, rate: 0.35, quick: 85920 },
  { limit: Infinity, rate: 0.45, quick: 181920 },
];

// ---- 按月换算税率表（全年一次性奖金单独计税专用） ----
// SRC: VERIFIED 财政部 税务总局公告2023年第30号（执行至2027-12-31，公式"奖金×税率−速算扣除数"）
//      https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211524/content.html
//      表值与公告附件"按月换算后的综合所得税率表"及多方官方口径一致
export const MONTHLY_BRACKETS = [
  { limit: 3000, rate: 0.03, quick: 0 },
  { limit: 12000, rate: 0.10, quick: 210 },
  { limit: 25000, rate: 0.20, quick: 1410 },
  { limit: 35000, rate: 0.25, quick: 2660 },
  { limit: 55000, rate: 0.30, quick: 4410 },
  { limit: 80000, rate: 0.35, quick: 7160 },
  { limit: Infinity, rate: 0.45, quick: 15160 },
];

// 基本减除费用（起征点）：5000/月
// SRC: VERIFIED 个人所得税法（同上法规库链接）
export const BASIC_DEDUCTION_ANNUAL = 60000;

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

function bracketFor(brackets, amount) {
  for (const b of brackets) if (amount <= b.limit) return b;
  return brackets[brackets.length - 1];
}

/** 综合所得应纳税额（按年，速算扣除数法） */
export function annualIncomeTax(annualTaxable) {
  const t = Math.max(0, annualTaxable);
  const b = bracketFor(ANNUAL_BRACKETS, t);
  return round2(t * b.rate - b.quick);
}

/** 全年一次性奖金单独计税应纳税额：奖金×按月换算税率−速算扣除数 */
export function bonusTaxSeparate(bonus) {
  const b = Math.max(0, bonus);
  if (b === 0) return 0;
  const br = bracketFor(MONTHLY_BRACKETS, b / 12);
  return round2(b * br.rate - br.quick);
}

/**
 * 年终奖"盲区"检测：单独计税下奖金略超临界点（3000/12000/25000/35000/55000/80000 的×12）
 * 时，税后到手反而低于临界点处。返回建议值。
 * 推导：net(x) = x(1−r1)+q1 与 net(edge)=edge(1−r0)+q0 相等
 *   → ceiling = [edge(1−r0)+q0−q1]/(1−r1)
 * 经典验证：zone1 ceiling = (36000×0.97−210)/0.9 = 38,566.67 ✓；zone2 = 160,500 ✓
 */
export function bonusBlindZone(bonus) {
  const b = Math.max(0, bonus);
  for (let i = 1; i < MONTHLY_BRACKETS.length; i++) {
    const edge = MONTHLY_BRACKETS[i - 1].limit * 12;
    const r0 = MONTHLY_BRACKETS[i - 1].rate;
    const q0 = MONTHLY_BRACKETS[i - 1].quick;
    const r1 = MONTHLY_BRACKETS[i].rate;
    const q1 = MONTHLY_BRACKETS[i].quick;
    const ceiling = round2((edge * (1 - r0) + q0 - q1) / (1 - r1));
    if (b > edge && b < ceiling) {
      const netAtEdge = edge * (1 - r0) + q0;
      const netHere = b * (1 - r1) + q1;
      return { inZone: true, edge, ceiling, suggest: edge, lost: round2(netAtEdge - netHere) };
    }
  }
  return { inZone: false };
}

// ---- 城市五险一金参数 ----
// 个人缴纳：养老/医疗/失业（工伤、生育个人不缴）；medicalFixedAdd 为固定小额附加（如北京大病3元/月）
// 基数来源：
//   上海 7546–37731（2026-07-01 起）：SRC: VERIFIED https://rsj.sh.gov.cn/tgsgg_17341/20260818/t0035_1443203.html
//   北京 7270–36348（2026 年 7 月起，京人社发〔2026〕7号）：SRC: VERIFIED https://rsj.beijing.gov.cn/xxgk/tzgg/202608/t20260821_4831468.html
//   深圳按养老口径 4775–27549（医疗 6727–33633、失业口径不同，工具内可在"高级"修改）：
//     SRC: VERIFIED(本地宝汇总) https://m.bendibao.com/mip/bsy3352.html
//   杭州（浙江省级统筹）4986–25299：SRC: VERIFIED(本地宝/杭州网) https://m.hz.bendibao.com/live/113816.shtm
//   广州（养老口径 5510–27549，2025.7–2026.6；医疗 6234–31170 为 2026.1–12，工具按单一基数简化）：
//     SRC: VERIFIED https://www.gz.gov.cn/zwfw/zxfw/sbfw/content/post_10510453.html
//           https://guangdong.chinatax.gov.cn/gdsw/ssfggds/2025-10/27/content_ba2a20bf040648e089f9edf9f557fa2b.shtml
//           广州单位医保费率 2026-01-01 起恢复 6%（含生育 0.85%）
// 公积金基数上限：
//   北京 36348（2026公积金年度）：SRC: VERIFIED https://www.beijing.gov.cn/zhengce/zhengcefagui/202608/t20260824_4834975.html
//   上海 37302（2026年度暂按2025年度执行，沪公积金管委会〔2026〕3号）：SRC: VERIFIED(多源报道一致)
//   其余城市：PENDING-VERIFY，可在"高级"修改（注意公积金基数与社保基数是两套体系，数值常不同）
// 雇主侧医疗/失业/工伤比例：部分城市 PENDING-VERIFY（仅影响"公司成本"列，不影响到手）
export const CITIES = {
  beijing: {
    name: '北京',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 3, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.098, unemployment: 0.005, injury: 0.004 },
    base: { lower: 7270, upper: 36348 },
    hf: { defaultRate: 0.12, cap: 36348 },
  },
  shanghai: {
    name: '上海',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.09, unemployment: 0.005, injury: 0.0026 },
    base: { lower: 7546, upper: 37731 },
    hf: { defaultRate: 0.07, cap: 37302 },
  },
  shenzhen: {
    name: '深圳',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.003 },
    employer: { pension: 0.15, medical: 0.05, unemployment: 0.003, injury: 0.0014 },
    base: { lower: 4775, upper: 27549 },
    hf: { defaultRate: 0.05, cap: 27549 },
  },
  hangzhou: {
    name: '杭州',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.099, unemployment: 0.005, injury: 0.002 },
    base: { lower: 4986, upper: 25299 },
    hf: { defaultRate: 0.12, cap: 25299 },
  },
  guangzhou: {
    name: '广州',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.002 },
    employer: { pension: 0.16, medical: 0.0685, unemployment: 0.002, injury: 0.002 },
    base: { lower: 5510, upper: 27549 },
    hf: { defaultRate: 0.05, cap: 27549 },
  },
  chengdu: {
    // 四川省级统筹 2026 年度（养老/失业/工伤）：SRC: VERIFIED(多源媒体一致，川人社办发〔2025〕39号)
    // https://cbgc.scol.com.cn/news/7932031 ；医保基数可能另有标准，可在"高级"修改
    name: '成都',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.069, unemployment: 0.005, injury: 0.002 },
    base: { lower: 4699, upper: 23493 },
    hf: { defaultRate: 0.06, cap: 23493 },
  },
  wuhan: {
    // 湖北第1档（武汉市和省直）：2026 年度暂按 2025 标准执行（4498–22488）
    // SRC: VERIFIED https://www.wuhan.gov.cn/zwgk/tzgg/202509/t20250922_2650944.shtml
    //      https://m12333.cn/qa/swsap.html （2026 年度申报口径）
    name: '武汉',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.08, unemployment: 0.005, injury: 0.002 },
    base: { lower: 4498, upper: 22488 },
    hf: { defaultRate: 0.08, cap: 22488 },
  },
  nanjing: {
    // 江苏（南京）：2026 新标准待发布，暂沿用 2025 标准 4952–24762
    // SRC: VERIFIED(多源) https://view.inews.qq.com/a/20260701A0A5B200
    //      https://m.nj.bendibao.com/live/137164.shtm ；江苏税务申报通知 jiangsu.chinatax.gov.cn
    name: '南京',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.08, unemployment: 0.005, injury: 0.002 },
    base: { lower: 4952, upper: 24762 },
    hf: { defaultRate: 0.08, cap: 24762 },
  },
  xian: {
    // 陕西省级统筹 2026 年度（养老/失业/工伤，2026-09-01 公布）：SRC: VERIFIED(多源媒体一致)
    // https://sx.sina.cn/news/xian/2026-09-01/detail-iniqiaty1629061.d.html
    // 医保口径可能另有标准，可在"高级"修改；公积金上限 PENDING-VERIFY
    name: '西安',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.08, unemployment: 0.005, injury: 0.002 },
    base: { lower: 4737, upper: 23685 },
    hf: { defaultRate: 0.08, cap: 23685 },
  },
  tianjin: {
    // 天津 2026 年度（五险统一口径，2026-09-01 起）：SRC: VERIFIED(多源)
    // 津人社局发〔2026〕5号 https://www.shui5.cn/article/9c/193309.html ；人社通 https://m12333.cn/qa/sifdb.html
    // 雇主侧医保/失业/工伤比例 PENDING-VERIFY（仅影响"公司成本"列）
    name: '天津',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.08, unemployment: 0.005, injury: 0.002 },
    base: { lower: 5180, upper: 25902 },
    hf: { defaultRate: 0.08, cap: 25902 },
  },
  changsha: {
    // 湖南省级统筹 2026 年度（养老/失业/工伤，基准值 6843，2026.1-12）：SRC: VERIFIED(多源)
    // https://hunan.voc.com.cn/news/202608/33553945.html ；医保口径可能另有标准
    name: '长沙',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.08, unemployment: 0.005, injury: 0.002 },
    base: { lower: 4106, upper: 20529 },
    hf: { defaultRate: 0.08, cap: 20529 },
  },
  hefei: {
    // 安徽省级统筹 2026 全年（皖人社秘〔2026〕113号，省人社厅 9-4 发布）：SRC: VERIFIED(官网+媒体一致)
    // 医保口径未单独核实；公积金上限 PENDING-VERIFY
    name: '合肥',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.08, unemployment: 0.005, injury: 0.002 },
    base: { lower: 4354, upper: 21772 },
    hf: { defaultRate: 0.08, cap: 21772 },
  },
  jinan: {
    // 山东省级统筹 2026 年度（鲁人社字〔2026〕75号，8-21 发布，五险统一）：SRC: VERIFIED(多源)
    name: '济南',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.08, unemployment: 0.005, injury: 0.002 },
    base: { lower: 4573, upper: 22863 },
    hf: { defaultRate: 0.08, cap: 22863 },
  },
  other: {
    name: '其他城市（自定义）',
    personal: { pension: 0.08, medical: 0.02, medicalFixedAdd: 0, unemployment: 0.005 },
    employer: { pension: 0.16, medical: 0.08, unemployment: 0.005, injury: 0.002 },
    base: { lower: 4000, upper: 30000 },
    hf: { defaultRate: 0.12, cap: 30000 },
  },
};

/** 解析城市与基数/缴存参数（evaluateOffer 与 monthlySchedule 共用） */
function resolveParams(input) {
  const city = CITIES[input.cityKey] || CITIES.other;
  const months = clamp(input.months || 12, 1, 24);
  const declaredBase = input.socialBaseOverride ?? input.monthlySalary;
  const socialBase = clamp(declaredBase, city.base.lower, city.base.upper);
  const hfBase = clamp(input.hfBaseOverride ?? input.monthlySalary, 0, city.hf.cap);
  const hfRate = clamp(input.hfRate ?? city.hf.defaultRate, 0, 0.12);
  const p = city.personal;
  const personalSI = round2(
    socialBase * (p.pension + p.medical + p.unemployment) + p.medicalFixedAdd
  );
  const personalHF = round2(hfBase * hfRate);
  // 税前可扣除口径：五险一金个人实缴（3元大病固定附加不可扣，金额影响极小，注释说明）
  const personalMonthlyDeduct = round2(personalSI - p.medicalFixedAdd + personalHF);
  return { city, months, socialBase, hfBase, hfRate, personalSI, personalHF, personalMonthlyDeduct };
}

/**
 * Offer 输入：
 * { label, cityKey, monthlySalary, months(12-16), annualBonus, signOn, annualStock,
 *   hfRate(0.05-0.12), socialBaseOverride?, hfBaseOverride?,
 *   specialDeductionMonthly(专项附加扣除合计/月), bonusSeparate(bool,默认true) }
 */
export function evaluateOffer(input) {
  const { city, months, socialBase, hfBase, hfRate, personalSI, personalHF, personalMonthlyDeduct } =
    resolveParams(input);

  // 收入类输入统一钳制非负（库函数防御：UI 之外的调用方可能传负数）
  const monthlySalary = Math.max(0, input.monthlySalary || 0);
  const annualBonus = Math.max(0, input.annualBonus || 0);
  const signOn = Math.max(0, input.signOn || 0);
  const annualStock = Math.max(0, input.annualStock || 0);
  const specialDeduction = Math.max(0, input.specialDeductionMonthly || 0);

  const salaryAnnual = round2(monthlySalary * months);
  const grossAnnual = round2(salaryAnnual + annualBonus + signOn + annualStock);

  // 工资侧应纳税所得额：工资+签字费+股票 − 6万 − 五险一金个人(12个月) − 专项附加(12个月)
  const salaryTaxableBase =
    salaryAnnual + signOn + annualStock -
    BASIC_DEDUCTION_ANNUAL -
    personalMonthlyDeduct * 12 -
    specialDeduction * 12;

  const bonus = annualBonus;
  let taxSalary, taxBonus = 0, bonusMode;
  if (input.bonusSeparate === false || bonus === 0) {
    taxSalary = annualIncomeTax(salaryTaxableBase + bonus);
    bonusMode = bonus === 0 ? '无年终奖' : '并入综合所得';
  } else {
    taxSalary = annualIncomeTax(salaryTaxableBase);
    taxBonus = bonusTaxSeparate(bonus);
    bonusMode = '单独计税';
  }

  const personalTotal = round2((personalSI + personalHF) * 12);
  const netAnnual = round2(grossAnnual - personalTotal - taxSalary - taxBonus);
  const netMonthlyAvg = round2(netAnnual / 12);

  const e = city.employer;
  const employerSI = round2(socialBase * (e.pension + e.medical + e.unemployment + e.injury));
  const employerHF = round2(hfBase * hfRate);
  const employerCostAnnual = round2(grossAnnual + (employerSI + employerHF) * 12);

  const bz = bonus > 0 && bonusMode === '单独计税' ? bonusBlindZone(bonus) : { inZone: false };

  return {
    label: input.label,
    cityName: city.name,
    months,
    socialBase, hfBase, hfRate,
    personalSI, personalHF,
    personalMonthlyDeduct,
    salaryAnnual, grossAnnual,
    taxableSalaryPart: Math.max(0, round2(salaryTaxableBase)),
    taxSalary, taxBonus, bonusMode,
    personalTotal, netAnnual, netMonthlyAvg,
    employerMonthlyCost: round2(employerSI + employerHF),
    employerCostAnnual,
    blindZone: bz,
  };
}

/** 多 offer 对比：按税后年总包降序 */
export function compareOffers(inputs) {
  return inputs.map(evaluateOffer).sort((a, b) => b.netAnnual - a.netAnnual);
}

/**
 * 逐月累计预扣明细（工资薪金累计预扣法）
 * 假设：1-12月每月工资相等；months>12 时超出部分（13薪等）计入12月发放；
 * 签字费计入1月；RSU 按季度（3/6/9/12月）平均归属。
 * 年终奖：单独计税时在12月单列 bonusTax；并入综合所得时把奖金并入12月工资侧税基
 *（保证 Σtax === evaluateOffer 的 taxSalary，两种模式口径一致）。
 * 返回 { rows: [{month, gross, cumTaxable, cumTax, tax, bonusTax}], totals: {taxSum, bonusTax} }
 */
export function monthlySchedule(input) {
  const { months, personalMonthlyDeduct } = resolveParams(input);
  const special = input.specialDeductionMonthly || 0;
  const extraMonths = Math.max(0, months - 12);
  const decExtra = extraMonths * input.monthlySalary;
  const perQuarterRSU = (input.annualStock || 0) / 4;
  const rsuMonths = [3, 6, 9, 12];
  const bonus = input.annualBonus || 0;
  const merged = bonus > 0 && input.bonusSeparate === false;

  const rows = [];
  let cumTaxable = 0;
  let cumTax = 0;
  for (let m = 1; m <= 12; m++) {
    let gross = m <= months ? input.monthlySalary : 0;
    if (m === 1) gross += input.signOn || 0;
    if (rsuMonths.includes(m)) gross += perQuarterRSU;
    if (m === 12) gross += decExtra + (merged ? bonus : 0);

    cumTaxable = cumTaxable + gross - 5000 - personalMonthlyDeduct - special;
    const newCumTax = annualIncomeTax(cumTaxable);
    const tax = round2(newCumTax - cumTax);
    cumTax = newCumTax;
    rows.push({
      month: m,
      gross: round2(gross),
      cumTaxable: Math.max(0, round2(cumTaxable)),
      cumTax: round2(cumTax),
      tax,
      bonusTax: 0,
    });
  }
  if (bonus > 0 && !merged) {
    rows[11].bonusTax = bonusTaxSeparate(bonus);
  }
  return {
    rows,
    totals: { taxSum: round2(cumTax), bonusTax: rows[11].bonusTax },
  };
}

export { round2, clamp };
