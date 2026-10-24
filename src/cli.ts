#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { assertLocalBind, loadConfig, type AppConfig } from "./config.js";
import { buildSampleRepository } from "./demo/sample-repo.js";
import { ArchaeologistError } from "./errors.js";
import { formatInvestigation } from "./format/human.js";
import { investigate } from "./pipeline.js";
import { startServer } from "./server/server.js";

export interface Io {
  log: (message: string) => void;
  error: (message: string) => void;
}

const defaultIo: Io = {
  log: (message) => process.stdout.write(message.endsWith("\n") ? message : `${message}\n`),
  error: (message) => process.stderr.write(message.endsWith("\n") ? message : `${message}\n`),
};

export async function runCli(
  argv: string[],
  io: Io = defaultIo,
  options: { env?: NodeJS.ProcessEnv; cwd?: string; loadEnvFile?: boolean } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const config = loadConfig(env, { cwd: options.cwd, loadEnvFile: options.loadEnvFile });
  const program = new Command();
  program
    .name("git-archaeologist")
    .description("Explain why a line of code exists by excavating git history, pull requests, reviews, and issues.")
    .showHelpAfterError()
    .configureOutput({
      writeOut: (message) => io.log(message),
      writeErr: (message) => io.error(message),
    })
    .exitOverride();

  program
    .command("investigate")
    .description("Trace a line or symbol and write a cited explanation")
    .requiredOption("-r, --repo <pathOrUrl>", "Local git path or GitHub repository URL")
    .requiredOption("-f, --file <path>", "File path relative to the repository root")
    .option("-l, --line <number>", "1-based line number")
    .option("-e, --end <number>", "Inclusive end line when tracing a range")
    .option("-s, --symbol <name>", "Function or symbol to locate")
    .option("-q, --question <text>", "Question to answer")
    .option("--offline", "Use fixtures or synthesized artifacts and the heuristic narrator")
    .option("--json", "Print the investigation as JSON")
    .option("--fixture <idOrPath>", "Fixture id (acme/widget) or path to fixture JSON")
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      const report = await investigate(
        {
          repo: String(opts.repo),
          file: String(opts.file),
          line: opts.line !== undefined ? parsePositiveInt(String(opts.line), "line") : undefined,
          end: opts.end !== undefined ? parsePositiveInt(String(opts.end), "end") : undefined,
          symbol: typeof opts.symbol === "string" ? opts.symbol : undefined,
          question: typeof opts.question === "string" ? opts.question : undefined,
          offline: Boolean(opts.offline) || config.offline,
          fixture: typeof opts.fixture === "string" ? opts.fixture : config.fixture,
        },
        config,
      );
      io.log(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatInvestigation(report));
    });

  program
    .command("demo")
    .description("Excavate the bundled sample repository with fixture data")
    .option("--json", "Print the investigation as JSON")
    .action(async (opts: { json?: boolean }) => {
      const report = await runDemo(config);
      io.log(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatInvestigation(report));
    });

  program
    .command("serve")
    .description("Start the local decision-graph UI")
    .option("-p, --port <number>", "Port", "4317")
    .option("--host <host>", "Loopback host", "127.0.0.1")
    .action(async (opts: { port: string; host: string }) => {
      const host = opts.host || "127.0.0.1";
      assertLocalBind(host);
      const port = parsePositiveInt(opts.port, "port");
      const running = await startServer({ host, port, config });
      io.log(`git-archaeologist listening on ${running.url}\n`);
      await new Promise(() => {
        /* keep the process alive until interrupted */
      });
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode !== 0 && err.message) io.error(err.message);
      return err.exitCode;
    }
    if (err instanceof ArchaeologistError) {
      io.error(err.message);
      return err.exitCode;
    }
    io.error(err instanceof Error ? err.message : "Unexpected failure");
    return 1;
  }
}

export async function runDemo(config: AppConfig) {
  const sample = await buildSampleRepository(path.join(config.cacheDir, "sample"));
  return investigate(
    {
      repo: sample.path,
      file: sample.file,
      line: sample.line,
      symbol: sample.symbol,
      question: "Why does the null and expiry guard in refreshSession exist?",
      offline: true,
    },
    { ...config, offline: true },
  );
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ArchaeologistError(`${name} must be a positive integer.`);
  }
  return parsed;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unexpected failure";
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}
