import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyAmountError, Money } from './money';

describe('Money Value Object', () => {
  it('should create valid instance with 2 decimal places', () => {
    const m = Money.from({ amount: '25.50', currency: 'BRL' });
    expect(m.toString()).toBe('25.50');
    expect(m.currency).toBe('BRL');
  });

  it('should format single decimal digit to 2 decimal places', () => {
    const m = Money.from({ amount: '25.5', currency: 'BRL' });
    expect(m.toString()).toBe('25.50');
  });

  it('should reject inputs with more than 2 decimal places', () => {
    expect(() => Money.from({ amount: '25.555', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('should reject scientific notation and invalid strings', () => {
    expect(() => Money.from({ amount: '1e-5', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('should reject negative amounts during creation', () => {
    expect(() => Money.from({ amount: '-10.00', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('should perform immutable addition and subtraction correctly', () => {
    const m1 = Money.from({ amount: '100.00', currency: 'BRL' });
    const m2 = Money.from({ amount: '25.50', currency: 'BRL' });

    const sum = m1.add(m2);
    expect(sum.toString()).toBe('125.50');
    expect(m1.toString()).toBe('100.00');

    const diff = m1.subtract(m2);
    expect(diff.toString()).toBe('74.50');
  });

  it('should throw when operating across different currencies', () => {
    const brl = Money.from({ amount: '100.00', currency: 'BRL' });
    const usd = Money.from({ amount: '100.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});