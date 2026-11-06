import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSummary, categoryTotals, expenseInMonth, incomeInMonth, monthlyTrend, occurrencesInMonth, type FinanceData } from '../src/lib/finance.ts';

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
