const tick = () => new Promise((r) => setTimeout(r, 1));

export function makeProcessor(policy) {
  const attempts = 3;
  return {
    async loadOrder(id) { await tick(); return { id, items: [{ price: 900, qty: 2 }] }; },
    async validate(order) {
      await tick();
      let total = 0;
      for (const i of order.items) total += i.price * i.qty;
      if (total > policy.maxTotal) throw new RangeError(`total ${total} over ${policy.maxTotal}`);
      return total;
    },
    async processOrder(id) {
      const order = await this.loadOrder(id);
      const receipt = await this.validate(order);
      return receipt;
    },
  };
}
