import { DatabaseSync } from "node:sqlite";

/**
 * D1 statements use numbered parameters (?1..?N) and real D1 accepts them, but node:sqlite
 * rejects numbered parameters when values are bound positionally ("column index out of
 * range"). Wrap a DatabaseSync so each statement is prepared with bare placeholders and its
 * values are expanded in parameter order. A parameter repeated in one statement is expanded
 * once per occurrence. This is needed only by the in-memory fake; it changes nothing about
 * how the Worker talks to D1.
 */
export function sqlite(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(database, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          const order: number[] = [];
          const statement = database.prepare(
            sql.replace(/\?(\d+)/g, (_match, index: string) => {
              order.push(Number(index));
              return "?";
            })
          );
          const expand = (values: unknown[]): unknown[] => order.map((position) => values[position - 1]);
          return new Proxy(statement, {
            get(bound, key) {
              if (key === "run" || key === "all" || key === "get") {
                return (...values: unknown[]) => (bound[key] as (...args: unknown[]) => unknown)(...expand(values));
              }
              const value = Reflect.get(bound, key, bound);
              return typeof value === "function" ? value.bind(bound) : value;
            }
          });
        };
      }
      const value = Reflect.get(database, property, receiver);
      return typeof value === "function" ? value.bind(database) : value;
    }
  }) as unknown as DatabaseSync;
}
