export type Frequency = 'monthly' | 'biweekly' | 'once';

export interface Income {
  id: string;
  name: string;
  amount: number;
  frequency: Frequency;
  date: string;
  category: string;
}

export interface Expense {
  id: string;
  name: string;
  amount: number;
  kind: 'fixed' | 'variable';
  category: string;
  date: string;
  frequency?: Frequency;
}

export interface SavingsGoal {
  id: string;
  name: string;
  target: number;
  saved: number;
  monthly: number;
  color?: string;
}

export interface FinanceData {
  incomes: Income[];
  expenses: Expense[];
  goals: SavingsGoal[];
  savingsAmount: number;
}

export const categories = [
  'Vivienda', 'Alimentación', 'Transporte', 'Educación', 'Ocio',
  'Viajes', 'Trabajo', 'Salud', 'Otros',
];

export const categoryColors: Record<string, string> = {
  Vivienda: '#087f46', Alimentación: '#a3c86d', Transporte: '#36a58b',
  Educación: '#5e8976', Ocio: '#c1dcb1', Salud: '#76b896',
  Viajes: '#187b74', Trabajo: '#64974b', Otros: '#8aa99b',
};

export const frequencyLabels: Record<Frequency, string> = {
  monthly: 'Mensual', biweekly: 'Quincenal', once: 'Ocasional',
};

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Amounts for recurring entries represent each payment, not a monthly total. */
export function occurrencesInMonth(date: string, frequency: Frequency, month: string): number {
  if (!monthPattern.test(month) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
  const startMonth = date.slice(0, 7);
  if (startMonth > month) return 0;
  if (frequency === 'once') return startMonth === month ? 1 : 0;
  return frequency === 'biweekly' ? 2 : 1;
}

export function incomeInMonth(income: Income, month: string): number {
  return round(income.amount * occurrencesInMonth(income.date, income.frequency, month));
}

export function expenseInMonth(expense: Expense, month: string): number {
  const frequency = expense.kind === 'variable' ? 'once' : expense.frequency ?? 'monthly';
  return round(expense.amount * occurrencesInMonth(expense.date, frequency, month));
}

export function calculateSummary(data: FinanceData, month: string) {
  const income = round(data.incomes.reduce((sum, entry) => sum + incomeInMonth(entry, month), 0));
  const fixedExpenses = round(data.expenses.filter(entry => entry.kind === 'fixed')
    .reduce((sum, entry) => sum + expenseInMonth(entry, month), 0));
  const variableExpenses = round(data.expenses.filter(entry => entry.kind === 'variable')
    .reduce((sum, entry) => sum + expenseInMonth(entry, month), 0));
  const savings = round(Math.max(0, data.savingsAmount));
  const freeBudget = round(income - fixedExpenses - savings);
  return {
    income, fixedExpenses, variableExpenses, savings, freeBudget,
    available: round(freeBudget - variableExpenses),
    savingsRate: income > 0 ? round(savings / income * 100) : 0,
  };
}

/** Includes all expenses; pass a filtered FinanceData to show only fixed ones. */
export function categoryTotals(data: FinanceData, month: string) {
  const totals = new Map<string, number>();
  for (const expense of data.expenses) {
    const value = expenseInMonth(expense, month);
    if (value > 0) totals.set(expense.category, round((totals.get(expense.category) ?? 0) + value));
  }
  return [...totals].map(([name, value]) => ({ name, value, color: categoryColors[name] ?? categoryColors.Otros }))
    .sort((a, b) => b.value - a.value);
}

export function monthlyTrend(data: FinanceData, month: string, count = 6) {
  if (!monthPattern.test(month)) return [];
  const [year, monthNumber] = month.split('-').map(Number);
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => {
    const date = new Date(Date.UTC(year, monthNumber - Math.max(0, Math.floor(count)) + index, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const summary = calculateSummary(data, key);
    return {
      month: key,
      label: new Intl.DateTimeFormat('es', { month: 'short', timeZone: 'UTC' }).format(date).replace('.', ''),
      income: summary.income,
      expenses: round(summary.fixedExpenses + summary.variableExpenses),
      savings: summary.savings,
      available: summary.available,
    };
  });
}

const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const recurringStart = `${now.getFullYear() - 1}-01-01`;

export const initialData: FinanceData = {
  incomes: [
    { id: 'income-salary', name: 'Salario mensual', amount: 3800, frequency: 'monthly', date: recurringStart, category: 'Salario' },
    { id: 'income-freelance', name: 'Proyecto freelance', amount: 450, frequency: 'once', date: `${currentMonth}-04`, category: 'Trabajo independiente' },
  ],
  expenses: [
    { id: 'expense-home', name: 'Alquiler del apartamento', amount: 1100, kind: 'fixed', category: 'Vivienda', date: recurringStart, frequency: 'monthly' },
    { id: 'expense-car', name: 'Cuota del carro', amount: 320, kind: 'fixed', category: 'Transporte', date: recurringStart, frequency: 'monthly' },
    { id: 'expense-study', name: 'Maestría', amount: 250, kind: 'fixed', category: 'Educación', date: recurringStart, frequency: 'monthly' },
    { id: 'expense-netflix', name: 'Netflix', amount: 15, kind: 'fixed', category: 'Ocio', date: recurringStart, frequency: 'monthly' },
    { id: 'expense-groceries', name: 'Supermercado', amount: 245, kind: 'variable', category: 'Alimentación', date: `${currentMonth}-02` },
    { id: 'expense-coffee', name: 'Café con amigos', amount: 18.5, kind: 'variable', category: 'Alimentación', date: `${currentMonth}-03` },
    { id: 'expense-dinner', name: 'Cena de fin de semana', amount: 72, kind: 'variable', category: 'Ocio', date: `${currentMonth}-04` },
    { id: 'expense-gas', name: 'Combustible', amount: 85, kind: 'variable', category: 'Transporte', date: `${currentMonth}-05` },
  ],
  goals: [
    { id: 'goal-travel', name: 'Viaje a Japón', target: 4000, saved: 2400, monthly: 250, color: '#36a58b' },
    { id: 'goal-emergency', name: 'Fondo de emergencia', target: 6000, saved: 3250, monthly: 350, color: '#087f46' },
  ],
  savingsAmount: 600,
};
