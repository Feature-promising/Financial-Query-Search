import neo4j, { type Driver } from "neo4j-driver";
import type { CypherReadClient } from "./neo4j-knowledge-graph.js";

/** Official Neo4j driver adapter; only the fixed graph repository calls it. */
export class Neo4jDriverClient implements CypherReadClient {
  private readonly driver: Driver;

  constructor(options: { uri: string; username: string; password: string; driver?: Driver }) {
    if (!/^neo4j(?:\+s|\+ssc)?:\/\//.test(options.uri)) throw new Error("Neo4j URI must use neo4j, neo4j+s, or neo4j+ssc");
    this.driver = options.driver ?? neo4j.driver(options.uri, neo4j.auth.basic(options.username, options.password));
  }

  async query(statement: string, parameters: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const session = this.driver.session({ defaultAccessMode: isWriteStatement(statement) ? neo4j.session.WRITE : neo4j.session.READ });
    try {
      const result = await session.run(statement, parameters);
      return result.records.map((record) => record.toObject());
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> { await this.driver.close(); }
}

function isWriteStatement(statement: string): boolean {
  return /\b(?:SET|CREATE|MERGE|DELETE|REMOVE)\b/i.test(statement);
}
