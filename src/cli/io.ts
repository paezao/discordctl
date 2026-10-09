import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function printJson(value: unknown): void {
  stdout.write(JSON.stringify(value, jsonReplacer, 2) + "\n");
}

export function print(text = ""): void {
  stdout.write(text + "\n");
}

export function eprint(text = ""): void {
  stderr.write(text + "\n");
}

export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY) && !process.env.CI;
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Read a secret from the terminal without echoing it. */
export async function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) throw new Error("No TTY available; use --token-stdin");
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    stdin.on("data", onData);
  });
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
