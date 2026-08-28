import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useApp } from "../state/AppContext";
import {
  checkLegShape,
  CheckResult,
  fetchPumpCurveFacts,
  fetchTargetMintFacts,
  MintFacts,
  PumpCurveFacts,
} from "../chain/admission";
import { Attribution, simulateValidateConfig } from "../chain/instructions";
import { splitAmounts } from "../chain/derive";

/** The canonical small-test-burn size Mode A probes admission at. */
export const PROBE_TOTAL_LAMPORTS = 50_000_000n;
import { CheckRows, legLabel } from "../ui";

export type LegDraft = {
  mint: string;
  bps: number;
  /** KEYLESS: bound reference pool address (address-bound venues only). */
  ref?: string;
  /** KEYLESS: resolved reference block, when the market scan has run. */
  referenceBlock?: {
    pool: PublicKey;
    vaultA: PublicKey;
    vaultB: PublicKey;
    feeSource: PublicKey;
  };
};

export function parseMint(value: string): PublicKey | null {
  try {
    return new PublicKey(value.trim());
  } catch {
    return null;
  }
}

// ---- admission hook -------------------------------------------------------

export type AdmissionState = {
  loading: boolean;
  shape: CheckResult[];
  targets: MintFacts[];
  curve: PumpCurveFacts | null;
  onChain: ({ ok: boolean } & Attribution) | null;
  /** Everything the CLIENT can prove passes (shape + every target). */
  clientPass: boolean;
  /** clientPass AND (when run) the deployed program's own verdict. */
  allPass: boolean;
};

/**
 * Runs the client-side admission mirrors for a config, plus (when the launch
 * mint already exists on chain) the deployed program's own read-only
 * `validate_config` verdict via simulation.
 */
export function useAdmission(
  launchMint: string | null,
  legs: LegDraft[],
  options: {
    simulateOnChain: boolean;
    checkPumpCurve: boolean;
    /** A mint this flow is ABOUT to create (Flow A's own launch token): a
     * missing account at this address is expected, not a failure. The real
     * verdict still runs on chain, atomically inside the setup transaction. */
    pendingMint?: string | null;
  }
): AdmissionState {
  const { connection, wallet, walletBalance, health } = useApp();
  const [state, setState] = useState<AdmissionState>({
    loading: false,
    shape: [],
    targets: [],
    curve: null,
    onChain: null,
    clientPass: false,
    allPass: false,
  });
  const runId = useRef(0);

  const legsKey = JSON.stringify(legs);
  const feePayer =
    wallet?.publicKey.toBase58() ??
    (health && health !== "down" ? health.payer ?? null : null);

  useEffect(() => {
    const id = ++runId.current;
    const parsedLegs = legs.map((leg) => ({
      ...leg,
      parsed: parseMint(leg.mint),
    }));
    const shape = checkLegShape(legs);
    const ready =
      parsedLegs.length > 0 && parsedLegs.every((leg) => leg.parsed !== null);
    if (!ready) {
      setState({
        loading: false,
        shape,
        targets: [],
        curve: null,
        onChain: null,
        clientPass: false,
        allPass: false,
      });
      return;
    }
    setState((s) => ({ ...s, loading: true, shape }));
    const timer = setTimeout(async () => {
      try {
        let targets = await fetchTargetMintFacts(
          connection,
          parsedLegs.map((leg) => leg.parsed as PublicKey)
        );
        targets = targets.map((facts) =>
          !facts.exists &&
          options.pendingMint &&
          facts.address === options.pendingMint
            ? {
                ...facts,
                admissible: true,
                checks: [
                  {
                    id: "pending",
                    label: "Own launch token (created by this flow)",
                    status: "info",
                    detail:
                      "a normal SOL-quoted Pump launch is born with null mint and freeze authorities — admissible; verified on chain during setup. While the bonding curve is live this leg burns DIRECTLY off the curve (no Jupiter involved, so no indexing wait); after graduation it burns via the canonical PumpSwap pool through Jupiter.",
                  },
                ],
              }
            : facts
        );
        const launch = launchMint ? parseMint(launchMint) : null;
        const curve =
          options.checkPumpCurve && launch
            ? await fetchPumpCurveFacts(connection, launch)
            : null;
        let onChain: AdmissionState["onChain"] = null;
        const shapeOk = shape.every((c) => c.status === "pass");
        if (options.simulateOnChain && launch && feePayer && shapeOk) {
          // KEYLESS: Mode A when every leg's reference block is resolved.
          // Without blocks we skip — Mode B is deleted (RT8).
          const allBlocks = parsedLegs.every((leg) => leg.referenceBlock);
          onChain = await simulateValidateConfig(
            connection,
            new PublicKey(feePayer),
            launch,
            parsedLegs.map((leg) => ({
              mint: leg.parsed as PublicKey,
              bps: leg.bps,
              ref: leg.ref ? new PublicKey(leg.ref) : undefined,
              referenceBlock: leg.referenceBlock,
            })),
            allBlocks
              ? splitAmounts(
                  PROBE_TOTAL_LAMPORTS,
                  parsedLegs.map((leg) => leg.bps)
                )
              : undefined
          );
        }
        if (runId.current !== id) return;
        const clientPass =
          shapeOk &&
          targets.every((t) => t.admissible) &&
          (curve === null || curve.checks.every((c) => c.status !== "fail"));
        const allPass =
          clientPass && (options.simulateOnChain ? onChain?.ok === true : true);
        setState({
          loading: false,
          shape,
          targets,
          curve,
          onChain,
          clientPass,
          allPass,
        });
      } catch {
        if (runId.current === id) setState((s) => ({ ...s, loading: false }));
      }
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connection,
    launchMint,
    legsKey,
    feePayer,
    // A just-funded fee payer changes the simulation outcome (an empty
    // payer fails externally), so re-run when the balance first lands.
    walletBalance === null || walletBalance === 0n,
    options.simulateOnChain,
    options.checkPumpCurve,
    options.pendingMint,
  ]);

  return state;
}

export function AdmissionPanel({
  admission,
  launchExists,
}: {
  admission: AdmissionState;
  launchExists: boolean;
}) {
  const targetChecks = admission.targets.flatMap((facts) =>
    facts.checks.map((check) => ({
      ...check,
      label: `${legLabel(facts.address)} — ${check.label}`,
    }))
  );
  const onChainRow: CheckResult[] = admission.onChain
    ? [
        admission.onChain.ok
          ? {
              id: "onchain",
              label: "Deployed program verdict (validate_config)",
              status: "pass" as const,
              detail: "the burn's own admission code accepts this config",
            }
          : {
              id: "onchain",
              label: "Deployed program verdict (validate_config)",
              status: "fail" as const,
              code: admission.onChain.isBurner
                ? admission.onChain.code
                : undefined,
              detail: admission.onChain.isBurner
                ? `${
                    admission.onChain.name ?? "rejected"
                  } — simulated against the deployed program`
                : `simulation failed externally (${
                    admission.onChain.programId ?? "unknown program"
                  })`,
            },
      ]
    : launchExists
    ? []
    : [
        {
          id: "onchain",
          label: "Deployed program verdict (validate_config)",
          status: "info" as const,
          detail:
            "runs atomically inside the setup transaction — an inadmissible config reverts the whole setup, fee share included",
        },
      ];
  return (
    <div>
      {admission.loading && (
        <p className="sub">
          <span className="spin" /> checking against the chain…
        </p>
      )}
      <CheckRows
        checks={[
          ...admission.shape,
          ...targetChecks,
          ...(admission.curve?.checks ?? []),
          ...onChainRow,
        ]}
      />
    </div>
  );
}
