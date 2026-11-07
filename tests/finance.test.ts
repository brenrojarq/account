import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSummary, categoryTotals, expenseInMonth, incomeInMonth, monthlyTrend, occurrencesInMonth, type FinanceData } from '../src/lib/finance.ts';
import type { CurrencyRateSnapshot } from '../src/lib/currency.ts';

// Synthetic conversion rates used only by the tests: NIO per USD/EUR.
const rates: CurrencyRateSnapshot = {
  usd: 40, eur: 50, rateType: 'sell', provider: 'manual',
  date: '2026-11-06', fetchedAt: '2026-11-06T12:00:00.000Z', dateKind: 'effective',
};

function fixture(): FinanceData {
  return {
    incomes: [
      { id: 'salary', name: 'Salario', amount: 1000, frequency: 'biweekly', date: '2026-01-01', category: 'Salario' },
      { id: 'one-off', name: 'Devolución', amount: 100, frequency: 'once', date: '2026-11-02', category: 'Otros' },
      { id: 'future', name: 'Nuevo empleo', amount: 500, frequency: 'monthly', date: '2026-12-01', category: 'Salario' },
    ],
    expenses: [
      { id: 'rent', name: 'Alquiler', amount: 500, kind: 'fixed', category: 'Vivienda', date: '2026-01-01' },
      { id: 'car', name: 'Carro', amount: 50, frequency: 'biweekly', kind: 'fixed', category: 'Transporte', date: '2026-01-01' },
      { id: 'food', name: 'Comida', amount: 12.3, kind: 'variable', category: 'Alimentación', date: '2026-11-01' },
      { id: 'food-2', name: 'Comida', amount: 0.2, kind: 'variable', category: 'Alimentación', date: '2026-11-02' },
      { id: 'past', name: 'Compra anterior', amount: 99, kind: 'variable', category: 'Compras', date: '2026-10-01' },
    ],
    goals: [], savingsAmount: 200,
  };
}

test('quincenal means two payments each calendar month, including February', () => {
  assert.equal(occurrencesInMonth('2026-01-01', 'biweekly', '2026-02'), 2);
  assert.equal(occurrencesInMonth('2026-03-01', 'monthly', '2026-02'), 0);
  assert.equal(occurrencesInMonth('2026-01-01', 'once', '2026-02'), 0);
});

test('available funds subtract fixed obligations, optional savings and current variable spending once', () => {
  assert.deepEqual(calculateSummary(fixture(), '2026-11'), {
    income: 2100, fixedExpenses: 600, variableExpenses: 12.5,
    savings: 200, freeBudget: 1300, available: 1287.5, savingsRate: 9.52,
    complete: true, missingConversions: [],
  });
});

test('occasional entries do not recur and future recurring entries start in their own month', () => {
  const result = calculateSummary(fixture(), '2026-12');
  assert.equal(result.income, 2500);
  assert.equal(result.variableExpenses, 0);
});

test('savings are optional, zero income remains finite, and overspending is visible', () => {
  const data = fixture();
  data.incomes = [];
  data.savingsAmount = 0;
  const result = calculateSummary(data, '2026-11');
  assert.equal(result.savingsRate, 0);
  assert.equal(result.freeBudget, -600);
  assert.equal(result.available, -612.5);
});

test('categories aggregate cents and exclude entries from other periods', () => {
  assert.deepEqual(categoryTotals(fixture(), '2026-11').map(({ name, value }) => ({ name, value })), [
    { name: 'Vivienda', value: 500 }, { name: 'Transporte', value: 100 }, { name: 'Alimentación', value: 12.5 },
  ]);
});

test('trend crosses year boundary, ends on requested month and uses the same ledger math', () => {
  const data = fixture();
  const trend = monthlyTrend(data, '2027-02', 4);
  assert.deepEqual(trend.map(entry => entry.month), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.equal(trend[0].expenses, 612.5);
  assert.equal(trend[3].income, 2500);
  assert.equal(trend[3].available, calculateSummary(data, '2027-02').available);
});

test('a one-time fixed commitment is reserved only in its own month', () => {
  const data = fixture();
  data.expenses = [{ id: 'enrollment', name: 'Matrícula', amount: 250, kind: 'fixed', frequency: 'once', category: 'Educación', date: '2026-11-30' }];
  assert.equal(expenseInMonth(data.expenses[0], '2026-10'), 0);
  assert.equal(calculateSummary(data, '2026-11').fixedExpenses, 250);
  assert.equal(calculateSummary(data, '2026-12').fixedExpenses, 0);
  assert.equal(categoryTotals(data, '2026-12').length, 0);
});

test('variable purchases stay one-time even if an old record retains a recurring frequency', () => {
  const purchase = { id: 'purchase', name: 'Compra', amount: 30, kind: 'variable' as const, frequency: 'biweekly' as const, category: 'Otros', date: '2026-11-01' };
  assert.equal(expenseInMonth(purchase, '2026-11'), 30);
  assert.equal(expenseInMonth(purchase, '2026-12'), 0);
});

test('savings goals track progress without deducting balances or suggested contributions a second time', () => {
  const data = fixture();
  const before = calculateSummary(data, '2026-11');
  data.goals = [
    { id: 'emergency', name: 'Fondo', target: 5000, saved: 3000, monthly: 150 },
    { id: 'trip', name: 'Viaje', target: 1000, saved: 400, monthly: 50 },
  ];
  assert.deepEqual(calculateSummary(data, '2026-11'), before);
  data.savingsAmount = 0;
  assert.equal(calculateSummary(data, '2026-11').available, before.available + 200);
});

test('monthly totals use payment frequency even when start day does not exist in a later month', () => {
  const salary = { id: 'salary', name: 'Salario', amount: 875.25, frequency: 'biweekly' as const, date: '2024-02-29', category: 'Salario' };
  assert.equal(incomeInMonth(salary, '2025-02'), 1750.5);
  assert.equal(incomeInMonth({ ...salary, frequency: 'monthly' }, '2025-02'), 875.25);
  assert.equal(incomeInMonth({ ...salary, frequency: 'once' }, '2025-02'), 0);
});

function mixedCurrencyFixture(): FinanceData {
  return {
    legacyCurrency: 'USD',
    incomes: [
      { id: 'usd-income', name: 'Salario', amount: 1000, currency: 'USD', frequency: 'monthly', date: '2026-01-01', category: 'Salario' },
      { id: 'nio-income', name: 'Trabajo local', amount: 4000, currency: 'NIO', frequency: 'once', date: '2026-11-01', category: 'Trabajo' },
      { id: 'eur-income', name: 'Trabajo europeo', amount: 100, currency: 'EUR', frequency: 'once', date: '2026-11-01', category: 'Trabajo' },
    ],
    expenses: [
      { id: 'rent-nio', name: 'Alquiler', amount: 20000, currency: 'NIO', kind: 'fixed', category: 'Vivienda', date: '2026-01-01' },
      { id: 'study-eur', name: 'Estudios', amount: 100, currency: 'EUR', kind: 'fixed', category: 'Educación', date: '2026-01-01' },
      { id: 'food-usd', name: 'Comida', amount: 100, currency: 'USD', kind: 'variable', category: 'Alimentación', date: '2026-11-01' },
    ],
    goals: [], savingsAmount: 4000, savingsCurrency: 'NIO',
  };
}

test('mixed-currency summary can switch among USD, NIO, and EUR without changing saved amounts', () => {
  const data = mixedCurrencyFixture();
  const original = JSON.stringify(data);
  assert.deepEqual(calculateSummary(data, '2026-11', { currency: 'USD', rates }), {
    income: 1225, fixedExpenses: 625, variableExpenses: 100, savings: 100,
    freeBudget: 500, available: 400, savingsRate: 8.16, complete: true, missingConversions: [],
  });
  assert.deepEqual(calculateSummary(data, '2026-11', { currency: 'NIO', rates }), {
    income: 49000, fixedExpenses: 25000, variableExpenses: 4000, savings: 4000,
    freeBudget: 20000, available: 16000, savingsRate: 8.16, complete: true, missingConversions: [],
  });
  const euros = calculateSummary(data, '2026-11', { currency: 'EUR', rates });
  assert.equal(euros.income, 980);
  assert.equal(euros.available, 320);
  assert.deepEqual(categoryTotals(data, '2026-11', { currency: 'EUR', rates }).map(({ name, value }) => ({ name, value })), [
    { name: 'Vivienda', value: 400 }, { name: 'Educación', value: 100 }, { name: 'Alimentación', value: 80 },
  ]);
  assert.equal(monthlyTrend(data, '2026-11', 1, { currency: 'EUR', rates })[0].available, euros.available);
  assert.equal(JSON.stringify(data), original);
});

test('captured record and savings rates remain stable when the current rate changes', () => {
  const data = mixedCurrencyFixture();
  data.incomes = [data.incomes[0]];
  data.expenses = [data.expenses[1]];
  data.incomes[0].exchangeRate = { ...rates };
  data.expenses[0].exchangeRate = { ...rates };
  data.savingsAmount = 100;
  data.savingsCurrency = 'USD';
  data.savingsExchangeRate = { ...rates };
  const before = JSON.stringify(data);
  const changedRate = { ...rates, usd: 80, eur: 100 };
  const result = calculateSummary(data, '2026-11', { currency: 'NIO', rates: changedRate });
  assert.equal(result.income, 40000);
  assert.equal(result.fixedExpenses, 5000);
  assert.equal(result.savings, 4000);
  assert.equal(result.available, 31000);
  assert.equal(JSON.stringify(data), before);
});

test('legacy entries retain the original account currency instead of adopting the summary currency', () => {
  const data: FinanceData = {
    legacyCurrency: 'NIO', incomes: [{ ...fixture().incomes[0], amount: 20000 }],
    expenses: [], goals: [], savingsAmount: 4000,
  };
  assert.equal(calculateSummary(data, '2026-11').income, 40000);
  assert.equal(calculateSummary(data, '2026-11', { currency: 'USD', rates }).income, 1000);
  assert.equal(calculateSummary(data, '2026-11', { currency: 'EUR', rates }).savings, 80);
  assert.equal(data.incomes[0].currency, undefined);
  assert.equal(data.incomes[0].amount, 20000);
});

test('unavailable rates invalidate their complete group and dependent totals rather than hiding entries', () => {
  const data = mixedCurrencyFixture();
  const result = calculateSummary(data, '2026-11', { currency: 'USD' });
  assert.equal(result.complete, false);
  assert.equal(result.income, null);
  assert.equal(result.fixedExpenses, null);
  assert.equal(result.variableExpenses, 100);
  assert.equal(result.savings, null);
  assert.equal(result.freeBudget, null);
  assert.equal(result.available, null);
  assert.equal(result.savingsRate, null);
  assert.deepEqual(result.missingConversions.map(({ id, currency, kind }) => ({ id, currency, kind })), [
    { id: 'nio-income', currency: 'NIO', kind: 'income' },
    { id: 'eur-income', currency: 'EUR', kind: 'income' },
    { id: 'rent-nio', currency: 'NIO', kind: 'expense' },
    { id: 'study-eur', currency: 'EUR', kind: 'expense' },
    { id: 'savings-reserved', currency: 'NIO', kind: 'savings' },
  ]);
  assert.deepEqual(categoryTotals(data, '2026-11', { currency: 'USD' }), []);
  const trend = monthlyTrend(data, '2026-11', 1, { currency: 'USD' });
  assert.equal(trend[0].income, null);
  assert.equal(trend[0].expenses, null);
  assert.equal(trend[0].available, null);
});

test('missing variable conversion leaves the known budget intact but makes available funds unknown', () => {
  const data = fixture();
  data.expenses = [{ ...data.expenses[2], currency: 'EUR' }];
  const result = calculateSummary(data, '2026-11', { currency: 'USD' });
  assert.equal(result.income, 2100);
  assert.equal(result.freeBudget, 1900);
  assert.equal(result.variableExpenses, null);
  assert.equal(result.available, null);
  assert.equal(result.complete, false);
});

test('future, inactive, and zero-value foreign entries do not require a conversion', () => {
  const data: FinanceData = {
    incomes: [{ ...fixture().incomes[0], currency: 'EUR', date: '2026-12-01' }],
    expenses: [{ ...fixture().expenses[2], currency: 'NIO', amount: 0 }],
    goals: [], savingsAmount: 0, savingsCurrency: 'EUR',
  };
  const result = calculateSummary(data, '2026-11', { currency: 'USD' });
  assert.equal(result.complete, true);
  assert.equal(result.income, 0);
  assert.equal(result.available, 0);
  assert.equal(result.savingsRate, 0);
  assert.equal(incomeInMonth(data.incomes[0], '2026-11', { currency: 'NIO' }), 0);
});

test('zero income yields a zero savings ratio even when a nonzero savings conversion is unavailable', () => {
  const data: FinanceData = { incomes: [], expenses: [], goals: [], savingsAmount: 10, savingsCurrency: 'EUR' };
  const result = calculateSummary(data, '2026-11', { currency: 'USD' });
  assert.equal(result.savings, null);
  assert.equal(result.savingsRate, 0);
  assert.equal(result.available, null);
});

test('monthly conversion helpers preserve original units with two arguments and use valid fallback rates with three', () => {
  const income = { ...fixture().incomes[0], currency: 'NIO' as const, amount: 20000 };
  const expense = { ...fixture().expenses[0], currency: 'EUR' as const, amount: 100, exchangeRate: { ...rates, eur: 0 } };
  assert.equal(incomeInMonth(income, '2026-11'), 40000);
  assert.equal(incomeInMonth(income, '2026-11', { currency: 'USD', rates }), 1000);
  assert.equal(expenseInMonth(expense, '2026-11'), 100);
  assert.equal(expenseInMonth(expense, '2026-11', { currency: 'USD', rates }), 125);
  assert.equal(expenseInMonth(expense, '2026-11', { currency: 'USD' }), null);
});

test('aggregation rounds after conversion and summation, including category and trend totals', () => {
  const data: FinanceData = {
    incomes: [], goals: [], savingsAmount: 0,
    expenses: Array.from({ length: 100 }, (_, index) => ({
      id: `small-${index}`, name: 'Compra', amount: 0.01, currency: 'USD' as const,
      kind: 'variable' as const, category: 'Otros', date: '2026-11-01',
    })),
  };
  const context = { currency: 'EUR' as const, rates: { ...rates, usd: 36.7, eur: 39.83 } };
  assert.equal(calculateSummary(data, '2026-11', context).variableExpenses, 0.92);
  assert.equal(categoryTotals(data, '2026-11', context)[0].value, 0.92);
  assert.equal(monthlyTrend(data, '2026-11', 1, context)[0].expenses, 0.92);
});
