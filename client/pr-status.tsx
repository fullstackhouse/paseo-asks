import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { Deployment, PrState } from "../shared/asks";
import { openLink } from "./open-link";
import type { Styles } from "./ui";

/** A PR's status as asks and PR cards show it: a badge, a facts line, and its preview deployments. */
const PR_STATE: Record<PrState["state"], string> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};
const CHECKS: Record<PrState["checks"], string> = {
  passing: "checks ✓",
  failing: "checks ✗",
  pending: "checks …",
  none: "",
};

export function PrBadge({ pr, styles }: { pr: PrState; styles: Styles }) {
  const tone =
    pr.state === "CLOSED" || pr.checks === "failing"
      ? styles.bad
      : pr.state === "MERGED" || pr.checks === "passing"
        ? styles.good
        : styles.muted;
  const label =
    pr.state === "OPEN" ? (pr.isDraft ? "draft" : CHECKS[pr.checks] || "open") : PR_STATE[pr.state];
  return <Text style={[styles.badge, tone]}>{label}</Text>;
}

export function PrDetail({ pr, styles }: { pr: PrState; styles: Styles }) {
  const parts = [
    `PR #${pr.number} ${pr.isDraft ? "draft" : PR_STATE[pr.state]}`,
    CHECKS[pr.checks],
    pr.reviewDecision ? pr.reviewDecision.toLowerCase().replace(/_/g, " ") : "no review decision",
    pr.state === "OPEN" && pr.mergeable === "CONFLICTING" ? "has conflicts" : "",
  ].filter(Boolean);
  return <Text style={styles.prDetail}>{parts.join(" · ")}</Text>;
}

const DEPLOYMENT: Record<Deployment["state"], { mark: string; verb: string; tone: "good" | "muted" | "bad" }> = {
  ready: { mark: "●", verb: "", tone: "good" },
  deploying: { mark: "◌", verb: "deploying ", tone: "muted" },
  failed: { mark: "✕", verb: "failed ", tone: "bad" },
};

/** Preview deployments of the PR's head commit: ready ones open the preview, the rest their logs. */
export function Deployments({ deployments, styles }: { deployments: Deployment[]; styles: Styles }) {
  return (
    <View style={styles.chips}>
      {deployments.map((deployment) => {
        const { mark, verb, tone } = DEPLOYMENT[deployment.state];
        // The URL-less entry's label already says "Deploying".
        const text = `${mark} ${deployment.url ? verb : ""}${deployment.label}`;
        const link = deployment.link;
        return (
          <Pressable
            key={`${deployment.url ?? ""}:${deployment.label}`}
            accessibilityRole="link"
            accessibilityLabel={text.slice(2)}
            disabled={!link}
            onPress={() => link && openLink(link)}
            style={styles.chip}
          >
            <Text style={[styles.chipText, styles[tone]]} numberOfLines={1}>
              {text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A PR link that opens the PR's review screen in paseo-inbox. */
export function InboxLink({ onPress, children }: { onPress(): void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="link" accessibilityHint="Opens in Inbox" onPress={onPress} style={{ alignSelf: "flex-start" }}>
      {children}
    </Pressable>
  );
}

