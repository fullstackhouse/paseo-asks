// A stand-in for the GitHub CLI that answers from a fixture instead of GitHub, for scenarios where an agent
// works a PR. It reads and writes $HOME/.fake-gh/state.json (the agents' HOME is the sandbox's) and appends
// every call to $HOME/.fake-gh/calls.jsonl, with `mutating: true` on the ones that would change GitHub.
// It only knows what the scenarios use; anything else fails loudly, so a recording shows what to add.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(process.env.HOME ?? homedir(), ".fake-gh");
const STATE = join(DIR, "state.json");
const state = JSON.parse(readFileSync(STATE, "utf8"));
const argv = process.argv.slice(2);
const repo = state.repo;
const slug = `${repo.owner}/${repo.name}`;

function log(entry) {
  appendFileSync(join(DIR, "calls.jsonl"), JSON.stringify({ argv, ...entry }) + "\n");
}

function save() {
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

function fail(message, code = 1) {
  process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  process.exit(code);
}

/** Splits argv into positionals and flags; `valued` names the flags that take a value. Repeated flags collect. */
function parse(args, valued) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    let [name, value] = arg.includes("=") && arg.startsWith("--") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (valued.includes(name) && value === undefined) value = args[++i];
    (flags[name] ??= []).push(value ?? true);
  }
  return { positional, flags };
}

const one = (flags, ...names) => names.map((name) => flags[name]?.at(-1)).find((value) => value !== undefined);

function output(value, flags) {
  const jq = one(flags, "--jq", "-q");
  const json = JSON.stringify(value);
  if (jq) {
    try {
      process.stdout.write(execFileSync("jq", ["-r", jq], { input: json, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
    } catch {
      // jq words its errors differently per version (macOS vs CI), and they land in what the model sees: keep them fixed.
      fail(`failed to parse jq expression: ${jq}`);
    }
  } else process.stdout.write(json + "\n");
}

function prOf(ref) {
  let number = ref && String(ref).match(/(\d+)\s*$/)?.[1];
  if (!number) {
    // No number: the PR whose head is the current branch, as gh does.
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    number = Object.keys(state.prs).find((key) => state.prs[key].headRefName === branch);
    if (!number) fail(`no pull requests found for branch "${branch}"`);
  }
  const pr = state.prs[number];
  if (!pr) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)`);
  return pr;
}

const urlOf = (pr) => `https://github.com/${slug}/pull/${pr.number}`;

/** The PR as `gh pr view --json` sees it, every field the scenarios read. */
function prJson(pr) {
  return {
    ...pr,
    url: urlOf(pr),
    labels: pr.labels.map((name) => ({ id: `LA_${name}`, name, description: "", color: "ededed" })),
    statusCheckRollup: pr.checks.map((check) => ({
      __typename: "CheckRun",
      name: check.name,
      workflowName: check.workflow,
      status: "COMPLETED",
      conclusion: check.conclusion.toUpperCase(),
      startedAt: state.time,
      completedAt: state.time,
      detailsUrl: `https://github.com/${slug}/actions/runs/1/job/1`,
    })),
    mergeable: pr.state === "OPEN" ? "MERGEABLE" : "UNKNOWN",
    mergeStateStatus: pr.state === "OPEN" ? pr.mergeStateStatus : "UNKNOWN",
    reviewRequests: [],
    assignees: [],
    files: pr.files.map((path) => ({ path, additions: 1, deletions: 1 })),
    commits: [{ oid: pr.headRefOid, messageHeadline: pr.title }],
  };
}

function pick(value, fields) {
  if (fields === true || fields === undefined) return value;
  return Object.fromEntries(fields.split(",").map((field) => [field.trim(), value[field.trim()] ?? null]));
}

function prText(pr) {
  return [
    `title:\t${pr.title}`,
    `state:\t${pr.state}`,
    `author:\t${pr.author.login}`,
    `labels:\t${pr.labels.join(", ")}`,
    `number:\t${pr.number}`,
    `url:\t${urlOf(pr)}`,
    "--",
    pr.body,
    "",
  ].join("\n");
}

function checksOf(pr, flags) {
  const rows = pr.checks.map((check) => ({
    name: check.name,
    state: check.conclusion.toUpperCase(),
    bucket: check.conclusion === "success" ? "pass" : "fail",
    workflow: check.workflow,
    link: `https://github.com/${slug}/actions/runs/1/job/1`,
    startedAt: state.time,
    completedAt: state.time,
    description: "",
    event: "pull_request",
  }));
  if (flags["--json"]) return output(rows.map((row) => pick(row, one(flags, "--json"))), flags);
  process.stdout.write(rows.map((row) => `${row.name}\t${row.bucket}\t12s\t${row.link}\t`).join("\n") + "\n");
  if (rows.some((row) => row.bucket === "fail")) process.exit(1);
}

const PR_VALUED = ["--json", "--jq", "-q", "--repo", "-R", "--template", "-t", "--add-label", "--remove-label", "--add-reviewer", "--remove-reviewer", "--body", "-b", "--body-file", "-F", "--title", "--base", "-B", "--match-head-commit", "--subject", "--state", "-s", "--head", "-H", "--limit", "-L", "--interval", "--author", "--label", "--search", "-S"];

function pr(sub, rest) {
  const { positional, flags } = parse(rest, PR_VALUED);
  switch (sub) {
    case "view": {
      const target = prOf(positional[0]);
      log({ mutating: false });
      if (flags["--json"]) return output(pick(prJson(target), one(flags, "--json")), flags);
      return process.stdout.write(prText(target));
    }
    case "checks": {
      log({ mutating: false });
      return checksOf(prOf(positional[0]), flags);
    }
    case "list": {
      log({ mutating: false });
      const wanted = (one(flags, "--state", "-s") ?? "open").toUpperCase();
      const head = one(flags, "--head", "-H");
      const rows = Object.values(state.prs)
        .filter((candidate) => wanted === "ALL" || candidate.state === wanted)
        .filter((candidate) => !head || candidate.headRefName === head)
        .map(prJson);
      if (flags["--json"]) return output(rows.map((row) => pick(row, one(flags, "--json"))), flags);
      return process.stdout.write(rows.map((row) => `${row.number}\t${row.title}\t${row.headRefName}\t${row.state}`).join("\n") + (rows.length ? "\n" : ""));
    }
    case "diff": {
      log({ mutating: false });
      const target = prOf(positional[0]);
      if (flags["--name-only"]) return process.stdout.write(target.files.join("\n") + "\n");
      return process.stdout.write(execFileSync("git", ["diff", `origin/${target.baseRefName}...${target.headRefOid}`], { encoding: "utf8" }));
    }
    case "edit": {
      const target = prOf(positional[0]);
      log({ mutating: true, pr: target.number });
      const split = (values) => (values ?? []).flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean);
      for (const label of split(flags["--add-label"])) if (!target.labels.includes(label)) target.labels.push(label);
      const removed = split(flags["--remove-label"]);
      target.labels = target.labels.filter((label) => !removed.includes(label));
      if (one(flags, "--title")) target.title = one(flags, "--title");
      if (one(flags, "--body", "-b")) target.body = one(flags, "--body", "-b");
      save();
      return process.stdout.write(urlOf(target) + "\n");
    }
    case "merge": {
      const target = prOf(positional[0]);
      log({ mutating: true, pr: target.number });
      if (target.state !== "OPEN") fail(`X Pull request ${slug}#${target.number} (${target.title}) can't be merged: it is ${target.state.toLowerCase()}`);
      const head = one(flags, "--match-head-commit");
      if (head && head !== target.headRefOid) fail(`X Pull request ${slug}#${target.number} (${target.title}) has a different head: ${target.headRefOid}`);
      if (target.mergeStateStatus === "BLOCKED" && !flags["--admin"]) {
        fail(
          `X Pull request ${slug}#${target.number} is not mergeable: the base branch policy prohibits the merge.\n` +
            "To have the pull request merged after all the requirements have been met, add the `--auto` flag.\n" +
            "To use administrator privileges to immediately merge the pull request, add the `--admin` flag.",
        );
      }
      target.state = "MERGED";
      target.mergedAt = state.time;
      target.mergeCommit = { oid: target.mergeOid };
      save();
      return process.stdout.write(`✓ Squashed and merged pull request ${slug}#${target.number} (${target.title})\n`);
    }
    case "comment":
    case "review":
    case "ready":
    case "close":
    case "reopen":
    case "create": {
      log({ mutating: true });
      return process.stdout.write(`https://github.com/${slug}/pull/${positional[0] ?? ""}\n`);
    }
  }
  unsupported();
}

/** REST GETs, by path with {owner}/{repo} filled in and the query string dropped. */
function restGet(path) {
  const prefix = `repos/${slug}`;
  if (path === "user") return { login: state.viewer, type: "User" };
  if (path === "rate_limit") return { resources: { core: { remaining: 5000 }, graphql: { remaining: 5000, reset: 0 } } };
  if (path === prefix)
    return { full_name: slug, name: repo.name, owner: { login: repo.owner }, private: repo.visibility === "PRIVATE", visibility: repo.visibility.toLowerCase(), default_branch: repo.defaultBranch, permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } };
  if (!path.startsWith(prefix + "/")) return undefined;
  const rest = path.slice(prefix.length + 1);
  let match;
  if ((match = rest.match(/^collaborators\/([^/]+)\/permission$/))) return { permission: match[1] === state.viewer ? "admin" : "write", role_name: match[1] === state.viewer ? "admin" : "write", user: { login: match[1] } };
  if ((match = rest.match(/^(?:pulls|issues)\/(\d+)$/))) {
    const target = prOf(match[1]);
    return { number: target.number, title: target.title, state: target.state === "OPEN" ? "open" : "closed", merged: target.state === "MERGED", draft: target.isDraft, user: target.author, head: { ref: target.headRefName, sha: target.headRefOid }, base: { ref: target.baseRefName }, labels: target.labels.map((name) => ({ name })), mergeable_state: target.mergeStateStatus.toLowerCase(), html_url: urlOf(target), body: target.body };
  }
  if ((match = rest.match(/^pulls\/(\d+)\/(comments|reviews)$/))) return [];
  if ((match = rest.match(/^pulls\/(\d+)\/requested_reviewers$/))) return { users: [], teams: [] };
  if ((match = rest.match(/^pulls\/(\d+)\/files$/))) return prOf(match[1]).files.map((filename) => ({ filename, status: "modified", additions: 1, deletions: 1 }));
  if ((match = rest.match(/^issues\/(\d+)\/comments$/)))
    return prOf(match[1]).comments.map((comment) => ({ user: { login: comment.author.login, type: "User" }, body: comment.body, created_at: comment.createdAt }));
  if ((match = rest.match(/^issues\/(\d+)\/labels$/))) return prOf(match[1]).labels.map((name) => ({ name }));
  if ((match = rest.match(/^commits\/([0-9a-f]{7,40})\/check-runs$/))) {
    const target = Object.values(state.prs).find((candidate) => candidate.headRefOid.startsWith(match[1]));
    const runs = (target?.checks ?? []).map((check) => ({ name: check.name, status: "completed", conclusion: check.conclusion, head_sha: target.headRefOid, app: { slug: "github-actions" }, html_url: `https://github.com/${slug}/actions/runs/1/job/1` }));
    return { total_count: runs.length, check_runs: runs };
  }
  if ((match = rest.match(/^commits\/([0-9a-f]{7,40})\/status$/))) return { state: "success", sha: match[1], total_count: 0, statuses: [] };
  if ((match = rest.match(/^commits\/([0-9a-f]{7,40})\/pulls$/))) return Object.values(state.prs).filter((candidate) => candidate.headRefOid.startsWith(match[1])).map((candidate) => restGet(`${prefix}/pulls/${candidate.number}`));
  if ((match = rest.match(/^branches\/(.+)\/protection\/required_status_checks$/))) {
    if (match[1] !== repo.defaultBranch) return null;
    return { strict: false, contexts: state.requiredChecks, checks: state.requiredChecks.map((context) => ({ context, app_id: 15368 })) };
  }
  if ((match = rest.match(/^branches\/(.+)\/protection$/))) {
    if (match[1] !== repo.defaultBranch) return null;
    return {
      required_status_checks: { strict: false, contexts: state.requiredChecks, checks: state.requiredChecks.map((context) => ({ context, app_id: 15368 })) },
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false, require_code_owner_reviews: false },
      enforce_admins: { enabled: false },
    };
  }
  if ((match = rest.match(/^branches\/([^/]+(?:\/[^/]+)*)$/))) return { name: match[1], protected: match[1] === repo.defaultBranch };
  if ((match = rest.match(/^rules\/branches\/(.+)$/))) return [];
  if (rest === "rulesets") return [];
  if (rest === "labels") return [...new Set(Object.values(state.prs).flatMap((candidate) => candidate.labels).concat("qa-approved"))].map((name) => ({ name }));
  if (rest === "environments") return { total_count: 0, environments: [] };
  if (rest.startsWith("environments/")) return null;
  if (rest === "actions/workflows") return { total_count: 1, workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] };
  if (rest.startsWith("actions/runs") || rest.match(/^actions\/workflows\/[^/]+\/runs$/)) return { total_count: 0, workflow_runs: [] };
  return undefined;
}

/** A GraphQL query answered with every field the scenarios ask for; unasked fields are harmless to the reader. */
function graphql(query, variables) {
  const number = Number(query.match(/pullRequest\(\s*number\s*:\s*(\d+)/)?.[1] ?? variables.number);
  const target = number ? state.prs[number] : undefined;
  const pullRequest = target && {
    ...prJson(target),
    viewerCanMergeAsAdmin: true,
    viewerCanUpdate: true,
    reviewRequests: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    latestReviews: { totalCount: 0, nodes: [] },
    reviews: { totalCount: 0, nodes: [] },
    labels: { nodes: target.labels.map((name) => ({ name })) },
    comments: { nodes: target.comments },
  };
  return { data: { viewer: { login: state.viewer }, repository: { nameWithOwner: slug, pullRequest } } };
}

function api(rest) {
  const { positional, flags } = parse(rest, ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--jq", "-q", "-H", "--header", "--input", "--hostname", "--template", "-t", "--cache"]);
  let path = (positional[0] ?? "").replace(/^\//, "").replace("{owner}", repo.owner).replace("{repo}", repo.name);
  path = path.split("?")[0];
  const fields = Object.fromEntries(
    ["-f", "-F", "--field", "--raw-field"].flatMap((name) => flags[name] ?? []).map((pair) => [String(pair).slice(0, String(pair).indexOf("=")), String(pair).slice(String(pair).indexOf("=") + 1)]),
  );
  const method = String(one(flags, "-X", "--method") ?? (Object.keys(fields).length && path !== "graphql" ? "POST" : "GET")).toUpperCase();

  if (path === "graphql") {
    const query = fields.query ?? "";
    const mutating = /^\s*mutation\b/.test(query);
    log({ mutating });
    return output(mutating ? { data: {} } : graphql(query, fields), flags);
  }
  if (method !== "GET") {
    log({ mutating: true });
    const labels = path.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/);
    if (labels && method === "POST") {
      const target = prOf(labels[1]);
      const added = Object.entries(fields).filter(([name]) => name.startsWith("labels")).map(([, value]) => value);
      for (const label of added) if (!target.labels.includes(label)) target.labels.push(label);
      save();
      return output(target.labels.map((name) => ({ name })), flags);
    }
    return output({}, flags);
  }
  log({ mutating: false });
  const value = restGet(path);
  if (value === undefined) unsupported();
  if (value === null) fail(`gh: Not Found (HTTP 404)\n{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}`);
  output(value, flags);
}

function unsupported() {
  log({ mutating: false, unsupported: true });
  fail(`fake gh: unsupported in this e2e fixture: gh ${argv.join(" ")}`);
}

const [command, sub, ...rest] = argv;
switch (command) {
  case "pr":
    pr(sub, rest);
    break;
  case "api":
    api([sub, ...rest].filter((arg) => arg !== undefined));
    break;
  case "repo": {
    if (sub !== "view") unsupported();
    log({ mutating: false });
    const { flags } = parse(rest, ["--json", "--jq", "-q", "--template", "-t"]);
    const value = {
      name: repo.name,
      nameWithOwner: slug,
      owner: { login: repo.owner },
      url: `https://github.com/${slug}`,
      visibility: repo.visibility,
      isPrivate: repo.visibility === "PRIVATE",
      defaultBranchRef: { name: repo.defaultBranch },
      viewerPermission: "ADMIN",
    };
    if (flags["--json"]) output(pick(value, one(flags, "--json")), flags);
    else process.stdout.write(`name:\t${slug}\ndescription:\t\n`);
    break;
  }
  case "auth":
    log({ mutating: false });
    process.stdout.write(`github.com\n  ✓ Logged in to github.com account ${state.viewer} (keyring)\n`);
    break;
  case "run": {
    const { flags } = parse(rest, ["--json", "--jq", "-q", "--workflow", "-w", "--commit", "-c", "--event", "-e", "--branch", "-b", "--limit", "-L"]);
    if (sub === "list") {
      log({ mutating: false });
      if (flags["--json"]) output([], flags);
      break;
    }
    if (sub === "rerun" || sub === "cancel") {
      log({ mutating: true });
      break;
    }
    unsupported();
    break;
  }
  case "workflow": {
    if (sub === "run") {
      log({ mutating: true });
      fail("could not create workflow dispatch event: HTTP 404: Not Found");
    }
    if (sub === "list") {
      log({ mutating: false });
      process.stdout.write("CI\tactive\t1\n");
      break;
    }
    unsupported();
    break;
  }
  case "label": {
    log({ mutating: sub !== "list" });
    if (sub === "list") process.stdout.write(restGet(`repos/${slug}/labels`).map((label) => `${label.name}\t\t#ededed`).join("\n") + "\n");
    break;
  }
  case "--version":
  case "version":
    log({ mutating: false });
    process.stdout.write("gh version 2.83.0 (2026-01-01)\n");
    break;
  default:
    unsupported();
}
