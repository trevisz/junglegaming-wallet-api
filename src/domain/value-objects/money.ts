import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(c1: string, c2: string) {
    super(`Currency mismatch: ${c1} and ${c2}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyAmountError extends Error {
  constructor(reason: string) {
    super(`Invalid money amount: ${reason}`);
    this.name = 'InvalidMoneyAmountError';
  }
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_EVEN });
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (!currency || currency.trim().length !== 3) {
      throw new InvalidMoneyAmountError('Currency must be a 3-letter ISO code');
    }

    if (typeof amount !== 'string' || amount.trim() === '') {
      throw new InvalidMoneyAmountError('Amount must be a non-empty string');
    }

    const trimmed = amount.trim();

    if (/[eE]/.test(trimmed)) {
      throw new InvalidMoneyAmountError('Scientific notation is not allowed');
    }

    if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
      throw new InvalidMoneyAmountError('Amount must have at most 2 decimal places');
    }

    let dec: Decimal;
    try {
      dec = new Decimal(trimmed);
    } catch {
      throw new InvalidMoneyAmountError('Failed to parse decimal string');
    }

    if (!dec.isFinite()) {
      throw new InvalidMoneyAmountError('Amount cannot be NaN or Infinity');
    }

    if (dec.isNegative()) {
      throw new InvalidMoneyAmountError('Amount cannot be negative');
    }

    return new Money(new Decimal(dec.toFixed(2, Decimal.ROUND_HALF_EVEN)), currency.toUpperCase());
  }

  private static createInternal(value: Decimal, currency: string): Money {
    return new Money(new Decimal(value.toFixed(2, Decimal.ROUND_HALF_EVEN)), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.createInternal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.createInternal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.createInternal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}