import { PolicyPicker, policyToLegs } from "./policyPicker";
import { buildPolicyLegs, DEFAULT_POLICY, VaultPolicy } from "../chain/policy";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useApp } from "../state/AppContext";
import { deriveSplitPda, legsToParam, splitAmounts } from "../chain/derive";
import {
  buildAtaInstructions,
  buildValidateConfigModeA,
  planSetupOnly,
  planSetupWithFeeShare,
  resolveLegs,
  sendWithWallet,
  SetupError,
} from "../chain/instructions";
import { buildFeeShareInstructions, feeSharingConfigPda } from "../chain/pump";
import {
  collectVaultAltAddresses,
  createVaultLookupTable,
} from "../chain/lookupTable";
import { ERROR_EXPLANATIONS } from "../chain/constants";
import { fetchPumpCurveFacts, PumpCurveFacts } from "../chain/admission";
import {
  AddressBlock,
  CheckRows,
  PermanenceConfirmation,
  StepState,
  TxSteps,
} from "../ui";
import {
  LegDraft,
  parseMint,
  PROBE_TOTAL_LAMPORTS,
  useAdmission,
} from "./configEditor";
import { ReferencePanel, useLegReferences } from "./referencePanel";
import { SETUP_LOOKUP_TABLE_ADDRESS } from "../config";
import { loadSetupLookupTable } from "../chain/setupLookupTable";
export function ExistingPage() {
  const { connection, wallet, saveVault, setVaultLookupTable } = useApp();
  const navigate = useNavigate();
  const [launchMint, setLaunchMint] = useState("");
  // Policy: creator-selected target 90%, NEIRO fixed at 10%.
  const [vaultPolicy, setVaultPolicy] = useState<VaultPolicy>(DEFAULT_POLICY);
  //
  // The 90% pick defaults to the namespace token itself: burn the token whose
  // creator fees fund this vault.
  const [creatorMintOverride, setCreatorMintOverride] = useState<string | null>(
    null
  );
  const creatorMint = creatorMintOverride ?? launchMint;
  const setCreatorMint = (value: string) => setCreatorMintOverride(value);
  const policy = buildPolicyLegs(creatorMint, vaultPolicy);
  const baseLegs: LegDraft[] = policyToLegs(policy);
  // KEYLESS: each leg binds a reference pool into the vault address. The
  // pick is automatic (Pump venue for Pump coins; the durability-then-depth
  // market scan otherwise) and shown in full below.
  const refState = useLegReferences(baseLegs);
  const legs: LegDraft[] = baseLegs.map((leg, i) => {
    const reference = refState.legReferences[i];
    return reference
      ? {
          ...leg,
          ref: reference.ref?.toBase58(),
          referenceBlock: {
            pool: reference.pool,
            vaultA: reference.vaultA,
            vaultB: reference.vaultB,
            feeSource: reference.feeSource,
          },
        }
      : leg;
  });
  const [curve, setCurve] = useState<PumpCurveFacts | null>(null);
  const [steps, setSteps] = useState<StepState[] | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [feeShareSteps, setFeeShareSteps] = useState<StepState[] | null>(null);
  const [feeShareRunning, setFeeShareRunning] = useState(false);

  const parsedLaunch = parseMint(launchMint);
  const admission = useAdmission(
    parsedLaunch && refState.ready ? launchMint : null,
    legs,
    {
      simulateOnChain: true,
      checkPumpCurve: false,
    }
  );

  useEffect(() => {
    setCurve(null);
    if (!parsedLaunch) return;
    let cancelled = false;
    fetchPumpCurveFacts(connection, parsedLaunch).then(
      (facts) => !cancelled && setCurve(facts)
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, launchMint]);

  const vault = useMemo(() => {
    if (!parsedLaunch || !refState.ready) return null;
    const parsed = legs.map((leg) => ({
      parsed: parseMint(leg.mint),
      bps: leg.bps,
      ref: leg.ref ? parseMint(leg.ref) ?? undefined : undefined,
    }));
    if (!parsed.length || parsed.some((leg) => !leg.parsed)) return null;
    try {
      return deriveSplitPda(
        parsedLaunch,
        parsed.map((leg) => ({
          mint: leg.parsed!,
          bps: leg.bps,
          ref: leg.ref,
        }))
      )[0].toBase58();
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchMint, JSON.stringify(legs), refState.ready]);

  const canRun =
    !!wallet && !!vault && refState.ready && admission.allPass && !running;
  const walletIsCreator =
    !!wallet &&
    !!curve?.creator &&
    curve.creator === wallet.publicKey.toBase58();

  async function runSetup() {
    if (!wallet || !vault || !parsedLaunch || !refState.ready) return;
    const parsedLegs = legs.map((leg) => ({
      mint: parseMint(leg.mint)!,
      bps: leg.bps,
      ref: leg.ref ? parseMint(leg.ref)! : undefined,
    }));
    const [pda] = deriveSplitPda(parsedLaunch, parsedLegs);
    setRunning(true);
    const plan: StepState[] = [
      { label: "validate_config + create ATAs (atomic)", status: "running" },
    ];
    setSteps([...plan]);
    try {
      const resolved = (await resolveLegs(connection, pda, parsedLegs)).map(
        (leg, i) => ({ ...leg, referenceBlock: legs[i].referenceBlock })
      );
      // Mode A: the burn's own admission checks PLUS its own price floor,
      // probed at the canonical small-test-burn size per leg — so a
      // reference that cannot price a burn reverts the whole setup here.
      const validateIx = buildValidateConfigModeA(
        pda,
        parsedLaunch,
        resolved,
        splitAmounts(
          PROBE_TOTAL_LAMPORTS,
          resolved.map((leg) => leg.bps)
        )
      );
      const ataIxs = buildAtaInstructions(wallet.publicKey, pda, resolved);
      const tx = planSetupOnly(wallet.publicKey, validateIx, ataIxs);
      plan[0] = {
        ...plan[0],
        label: `${tx.label} — ${tx.bytes} bytes`,
        status: "running",
      };
      setSteps([...plan]);
      const signature = await sendWithWallet(
        connection,
        wallet,
        tx.instructions
      );
      plan[0] = { ...plan[0], status: "done", signature };
      setSteps([...plan]);
      saveVault({
        label: legs.map((l) => l.bps).join("/"),
        launchMint,
        legs: legs.map(({ mint, bps, ref }) => ({ mint, bps, ref })),
        vault,
        createdAt: Date.now(),
      });
      // Two-leg 90/10 burns use the service's measured maxAccounts fitting
      // ladder and do not create a table. Larger custom configurations keep
      // the creator-owned lookup-table fallback.
      if (parsedLegs.length >= 3) {
        plan.push({
          label: "create address lookup table (3+ leg burn)",
          status: "running",
        });
        setSteps([...plan]);
        try {
          const references = refState.legReferences;
          const altAddresses = collectVaultAltAddresses({
            vault: pda,
            launchMint: parsedLaunch,
            legs: resolved.map((leg, i) => ({
              mint: leg.mint,
              tokenProgram: leg.tokenProgram,
              pool: references[i]!.pool,
              vaultA: references[i]!.vaultA,
              vaultB: references[i]!.vaultB,
              feeSource: references[i]!.feeSource,
            })),
          });
          const table = await createVaultLookupTable(
            connection,
            wallet,
            altAddresses,
            (line) => {
              plan[plan.length - 1] = {
                ...plan[plan.length - 1],
                label: `address lookup table — ${line}`,
                status: "running",
              };
              setSteps([...plan]);
            }
          );
          setVaultLookupTable(vault, table.toBase58());
          plan[plan.length - 1] = {
            ...plan[plan.length - 1],
            label: `address lookup table ${table.toBase58()}`,
            status: "done",
          };
          setSteps([...plan]);
        } catch (altError) {
          plan[plan.length - 1] = {
            ...plan[plan.length - 1],
            status: "failed",
            detail: `the vault is set up and valid, but its lookup table was not created — make it later from the vault page before a 3+ leg burn. ${String(
              (altError as Error).message ?? altError
            ).slice(0, 200)}`,
          };
          setSteps([...plan]);
        }
      }
      setDone(true);
      setRunning(false);
    } catch (error) {
      const detail =
        error instanceof SetupError
          ? `${error.message}${
              error.attribution.code !== undefined &&
              ERROR_EXPLANATIONS[error.attribution.code]
                ? ` — ${ERROR_EXPLANATIONS[error.attribution.code]}`
                : ""
            }`
          : String((error as Error).message ?? error).slice(0, 300);
      plan[0] = { ...plan[0], status: "failed", detail };
      setSteps([...plan]);
      setRunning(false);
    }
  }

  async function runFeeShare() {
    if (!wallet || !vault || !parsedLaunch || !refState.ready) return;
    const parsedLegs = legs.map((leg) => ({
      mint: parseMint(leg.mint)!,
      bps: leg.bps,
      ref: leg.ref ? parseMint(leg.ref)! : undefined,
    }));
    const [pda] = deriveSplitPda(parsedLaunch, parsedLegs);
    setFeeShareRunning(true);
    const plan: StepState[] = [
      {
        label: "prepare immutable fee-share commitment",
        status: "running",
      },
    ];
    setFeeShareSteps([...plan]);
    try {
      const resolved = (await resolveLegs(connection, pda, parsedLegs)).map(
        (leg, index) => ({
          ...leg,
          referenceBlock: legs[index].referenceBlock,
        })
      );
      const validateA = buildValidateConfigModeA(
        pda,
        parsedLaunch,
        resolved,
        splitAmounts(
          PROBE_TOTAL_LAMPORTS,
          resolved.map((leg) => leg.bps)
        )
      );
      const ataIxs = buildAtaInstructions(wallet.publicKey, pda, resolved);
      const shareIxs = await buildFeeShareInstructions({
        creator: wallet.publicKey,
        mint: parsedLaunch,
        vault: pda,
      });
      // If the sharing config PDA already exists, creating it again would
      // fail — only send the update in that case.
      const configExists =
        (await connection.getAccountInfo(feeSharingConfigPda(parsedLaunch))) !==
        null;
      const feeShareIxs = configExists ? [shareIxs[1]] : shareIxs;
      const setupLookupTable = await loadSetupLookupTable(
        connection,
        SETUP_LOOKUP_TABLE_ADDRESS
      );
      const setupPlan = planSetupWithFeeShare(
        wallet.publicKey,
        feeShareIxs,
        validateA,
        ataIxs,
        setupLookupTable ? [setupLookupTable] : []
      );
      plan.splice(
        0,
        1,
        ...setupPlan.transactions.map((transaction) => ({
          label: `${transaction.label} — ${transaction.bytes} bytes`,
          status: "idle" as const,
        }))
      );
      setFeeShareSteps([...plan]);
      for (let index = 0; index < setupPlan.transactions.length; index++) {
        plan[index] = { ...plan[index], status: "running" };
        setFeeShareSteps([...plan]);
        const signature = await sendWithWallet(
          connection,
          wallet,
          setupPlan.transactions[index].instructions,
          [],
          setupPlan.transactions[index].lookupTables
        );
        plan[index] = { ...plan[index], status: "done", signature };
        setFeeShareSteps([...plan]);
      }
      saveVault({
        label: legs.map((leg) => leg.bps).join("/"),
        launchMint,
        legs: legs.map(({ mint, bps, ref }) => ({ mint, bps, ref })),
        vault,
        createdAt: Date.now(),
        feeShare: true,
      });
    } catch (error) {
      let detail =
        error instanceof SetupError
          ? error.message
          : String((error as Error).message ?? error).slice(0, 300);
      if (/1779|0x1779/.test(detail)) {
        detail +=
          " — Pump refuses re-pointing an existing fee share (0x1779). The share is one-shot; it is already committed elsewhere.";
      }
      const failedIndex = plan.findIndex((step) => step.status === "running");
      const at = failedIndex >= 0 ? failedIndex : plan.length - 1;
      plan[at] = { ...plan[at], status: "failed", detail };
      setFeeShareSteps([...plan]);
    } finally {
      setFeeShareRunning(false);
    }
  }

  return (
    <div>
      <div className="hero-copy">
        <h1>Create a vault for an existing token</h1>
        <p>
          Point your creator payments at a vault and it buys and burns the
          tokens you choose, over and over, for as long as money keeps arriving.
          Any SOL works — creator fees, trading fees, or someone just sending
          it.
        </p>
      </div>

      <div className="grid2">
        <div>
          <div className="panel">
            <h2>Launch mint (namespace)</h2>
            <label className="field">
              <span className="name">Existing mint address</span>
              <input
                type="text"
                className="mono"
                value={launchMint}
                placeholder="paste a mint address"
                disabled={running}
                onChange={(e) => setLaunchMint(e.target.value.trim())}
              />
            </label>
            {launchMint && !parsedLaunch && (
              <p className="sub" style={{ color: "var(--err)" }}>
                not a valid address
              </p>
            )}
            {curve && <CheckRows checks={curve.checks} />}
            {curve?.exists && !curve.solQuoted && null}
          </div>

          <div className="panel">
            <h2>Burn targets</h2>
            <PolicyPicker
              policy={vaultPolicy}
              onPolicyChange={setVaultPolicy}
              creatorMint={creatorMint}
              onChange={setCreatorMint}
              disabled={running}
            />
          </div>

          <div className="panel">
            <h2>Reference pools — permanent price anchors</h2>
            <ReferencePanel legs={baseLegs} state={refState} />
          </div>
        </div>

        <div>
          <div className="panel">
            <h2>Derived vault</h2>
            <p className="sub">
              Point any SOL payout at this address once setup has landed. The
              config cannot change afterwards — a different config is a
              different address.
            </p>
            {vault ? (
              <AddressBlock value={vault} hero />
            ) : (
              <p className="sub">
                enter the launch mint and targets to derive the vault
              </p>
            )}
          </div>

          <div className="panel">
            <h2>Set up the vault</h2>
            {vault && <PermanenceConfirmation vault={vault} legs={legs} />}
            <button
              className="btn primary"
              disabled={!canRun}
              onClick={runSetup}
            >
              {running ? "running…" : "validate + create ATAs"}
            </button>
            {steps && (
              <div style={{ marginTop: 14 }}>
                <TxSteps steps={steps} />
              </div>
            )}
            {done && vault && (
              <div className="plain-message" style={{ marginTop: 12 }}>
                Vault ready. Fund it by sending SOL to the address above, then{" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate({
                      to: "/vault",
                      search: {
                        launch: launchMint,
                        legs: legsToParam(legs),
                        label: "",
                      },
                    });
                  }}
                >
                  open the vault page
                </a>{" "}
                to burn. Run a small test burn before pointing real payouts at
                it.
              </div>
            )}
          </div>

          {curve?.exists && (
            <div className="panel">
              <h2>Point Pump creator fees here</h2>
              {walletIsCreator ? (
                <>
                  {vault && (
                    <PermanenceConfirmation vault={vault} legs={legs} />
                  )}
                  <button
                    className="btn"
                    disabled={
                      !wallet || !vault || feeShareRunning || !admission.allPass
                    }
                    onClick={runFeeShare}
                  >
                    {feeShareRunning
                      ? "committing…"
                      : "commit 100% fee share to this vault"}
                  </button>
                  {feeShareSteps && (
                    <div style={{ marginTop: 12 }}>
                      <TxSteps steps={feeShareSteps} />
                    </div>
                  )}
                </>
              ) : (
                <p className="sub">
                  This is a Pump launch
                  {curve.creator ? ` created by ${curve.creator}` : ""}. Only
                  that creator wallet can point its fee share at the vault.
                  Anyone can still fund the vault directly.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
