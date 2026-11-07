import {
  convertAmount, isValidRateSnapshot, resolveCurrency, roundCurrency,
  type Currency, type CurrencyRateSnapshot,
} from './currency';

export type Frequency = 'monthly' | 'biweekly' | 'once';

export interface ConversionContext {
  currency: Currency;
  rates?: CurrencyRateSnapshot | null;
}

interface CurrencyRecord {
  currency?: Currency;
  exchangeRate?: CurrencyRateSnapshot;
}

export interface Income extends CurrencyRecord {
  id: string;
  name: string;
  amount: number;
  frequency: Frequency;
  date: string;
  category: string;
}

export interface Expense extends CurrencyRecord {
  id: string;
  name: string;
  amount: number;
  kind: 'fixed' | 'variable';
  category: string;
  date: string;
  frequency?: Frequency;
}

export interface SavingsGoal extends CurrencyRecord {
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
  legacyCurrency?: Currency;
  savingsCurrency?: Currency;
  savingsExchangeRate?: CurrencyRateSnapshot;
}

export interface MissingConversion {
  id: string;
  name: string;
  currency: Currency;
  kind: 'income' | 'expense' | 'savings';
}

export interface FinanceSummary {
  income: number | null;
  fixedExpenses: number | null;
  variableExpenses: number | null;
  savings: number | null;
  freeBudget: number | null;
  available: number | null;
  savingsRate: number | null;
  complete: boolean;
  missingConversions: MissingConversion[];
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

const round = roundCurrency;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Amounts for recurring entries represent each payment, not a monthly total. */
export function occurrencesInMonth(date: string, frequency: Frequency, month: string): number {
  if (!monthPattern.test(month) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
  const startMonth = date.slice(0, 7);
  if (startMonth > month) return 0;
  if (frequency === 'once') return startMonth === month ? 1 : 0;
  return frequency === 'biweekly' ? 2 : 1;
}

export function entryCurrency(entry: CurrencyRecord, data?: Pick<FinanceData, 'legacyCurrency'>): Currency {
  return resolveCurrency(entry.currency, resolveCurrency(data?.legacyCurrency));
}

/** Captured rates belong to a saved record and remain stable as today's rate changes. */
export function resolveEntryRate(entry: CurrencyRecord, context: ConversionContext): CurrencyRateSnapshot | null {
  if (isValidRateSnapshot(entry.exchangeRate)) return entry.exchangeRate;
  return isValidRateSnapshot(context.rates) ? context.rates : null;
}

function incomeAmount(income: Income, month: string): number {
  return income.amount * occurrencesInMonth(income.date, income.frequency, month);
}

function expenseAmount(expense: Expense, month: string): number {
  const frequency = expense.kind === 'variable' ? 'once' : expense.frequency ?? 'monthly';
  return expense.amount * occurrencesInMonth(expense.date, frequency, month);
}

function convertedAmount(entry: CurrencyRecord, amount: number, context: ConversionContext, data?: FinanceData): number | null {
  return convertAmount(amount, entryCurrency(entry, data), context.currency, resolveEntryRate(entry, context));
}

export function incomeInMonth(income: Income, month: string): number;
export function incomeInMonth(income: Income, month: string, context: ConversionContext): number | null;
export function incomeInMonth(income: Income, month: string, context?: ConversionContext): number | null {
  const amount = incomeAmount(income, month);
  return context ? convertedAmount(income, amount, context) : round(amount);
}

export function expenseInMonth(expense: Expense, month: string): number;
export function expenseInMonth(expense: Expense, month: string, context: ConversionContext): number | null;
export function expenseInMonth(expense: Expense, month: string, context?: ConversionContext): number | null {
  const amount = expenseAmount(expense, month);
  return context ? convertedAmount(expense, amount, context) : round(amount);
}

function rawSummary(data: FinanceData, month: string, context: ConversionContext) {
  const missingConversions: MissingConversion[] = [];
  const totalEntries = (entries: (Income | Expense)[], kind: 'income' | 'expense'): number | null => {
    let total: number | null = 0;
    for (const entry of entries) {
      const amount = kind === 'income' ? incomeAmount(entry as Income, month) : expenseAmount(entry as Expense, month);
      const converted = convertedAmount(entry, amount, context, data);
      if (converted === null) {
        missingConversions.push({ id: entry.id, name: entry.name, currency: entryCurrency(entry, data), kind });
        total = null;
      } else if (total !== null) total += converted;
    }
    return total;
  };
  const income = totalEntries(data.incomes, 'income');
  const fixedExpenses = totalEntries(data.expenses.filter(entry => entry.kind === 'fixed'), 'expense');
  const variableExpenses = totalEntries(data.expenses.filter(entry => entry.kind === 'variable'), 'expense');
  const savingsRecord = { currency: data.savingsCurrency, exchangeRate: data.savingsExchangeRate };
  const savings = convertedAmount(savingsRecord, Math.max(0, data.savingsAmount), context, data);
  if (savings === null) missingConversions.push({
    id: 'savings-reserved', name: 'Ahorro reservado', currency: entryCurrency(savingsRecord, data), kind: 'savings',
  });
  return { income, fixedExpenses, variableExpenses, savings, missingConversions };
}

function summaryOutput(raw: ReturnType<typeof rawSummary>): FinanceSummary {
  const { income, fixedExpenses, variableExpenses, savings, missingConversions } = raw;
  const freeBudget = income === null || fixedExpenses === null || savings === null ? null : income - fixedExpenses - savings;
  const output = (value: number | null) => value === null ? null : round(value);
  return {
    income: output(income), fixedExpenses: output(fixedExpenses), variableExpenses: output(variableExpenses),
    savings: output(savings), freeBudget: output(freeBudget),
    available: freeBudget === null || variableExpenses === null ? null : round(freeBudget - variableExpenses),
    savingsRate: income === null ? null : income <= 0 ? 0 : savings === null ? null : round(savings / income * 100),
    complete: missingConversions.length === 0,
    missingConversions,
  };
}

export function calculateSummary(data: FinanceData, month: string, context?: ConversionContext): FinanceSummary {
  return summaryOutput(rawSummary(data, month, context ?? { currency: resolveCurrency(data.legacyCurrency) }));
}

/** Includes all expenses; pass a filtered FinanceData to show only fixed ones. */
export function categoryTotals(data: FinanceData, month: string, context?: ConversionContext) {
  const conversion = context ?? { currency: resolveCurrency(data.legacyCurrency) };
  const totals = new Map<string, number>();
  for (const expense of data.expenses) {
    const value = convertedAmount(expense, expenseAmount(expense, month), conversion, data);
    if (value === null) return [];
    if (value > 0) totals.set(expense.category, (totals.get(expense.category) ?? 0) + value);
  }
  return [...totals].map(([name, value]) => ({ name, value: round(value), color: categoryColors[name] ?? categoryColors.Otros }))
    .sort((a, b) => b.value - a.value);
}

export function monthlyTrend(data: FinanceData, month: string, count = 6, context?: ConversionContext) {
  if (!monthPattern.test(month)) return [];
  const [year, monthNumber] = month.split('-').map(Number);
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => {
    const date = new Date(Date.UTC(year, monthNumber - Math.max(0, Math.floor(count)) + index, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const raw = rawSummary(data, key, context ?? { currency: resolveCurrency(data.legacyCurrency) });
    const summary = summaryOutput(raw);
    return {
      month: key,
      label: new Intl.DateTimeFormat('es', { month: 'short', timeZone: 'UTC' }).format(date).replace('.', ''),
      income: summary.income,
      expenses: raw.fixedExpenses === null || raw.variableExpenses === null ? null : round(raw.fixedExpenses + raw.variableExpenses),
      savings: summary.savings,
      available: summary.available,
    };
  });
}

const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const recurringStart = `${now.getFullYear() - 1}-01-01`;

export const initialData: FinanceData = {
  legacyCurrency: 'USD',
  savingsCurrency: 'USD',
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
