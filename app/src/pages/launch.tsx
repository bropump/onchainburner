import { useEffect, useMemo, useRef, useState } from "react";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { Buffer } from "buffer";
import { useNavigate } from "@tanstack/react-router";
import { useApp } from "../state/AppContext";
import { deriveSplitPda, legsToParam, splitAmounts } from "../chain/derive";
import {
  buildAtaInstructions,
  buildValidateConfigModeA,
  planSetupWithFeeShare,
  resolveLegs,
  sendWithWallet,
  SetupError,
} from "../chain/instructions";
import {
  buildCreateV2Instruction,
  buildFeeShareInstructions,
} from "../chain/pump";
import {
  collectVaultAltAddresses,
  createVaultLookupTable,
} from "../chain/lookupTable";
import { ERROR_EXPLANATIONS } from "../chain/constants";
import { CopyButton, shortAddress, StepState, TxSteps } from "../ui";
import {
  LegDraft,
  parseMint,
  PROBE_TOTAL_LAMPORTS,
  useAdmission,
} from "./configEditor";
import {
  ReferencePanel,
  referencesAreSupported,
  useLegReferences,
} from "./referencePanel";
import { PolicyPicker, policyToLegs } from "./policyPicker";
import { buildPolicyLegs, DEFAULT_POLICY, VaultPolicy } from "../chain/policy";
import {
  MAX_METADATA_IMAGE_BYTES,
  METADATA_IMAGE_TYPES,
} from "../chain/service";
import { SETUP_LOOKUP_TABLE_ADDRESS } from "../config";
import { loadSetupLookupTable } from "../chain/setupLookupTable";

export function LaunchPage() {
  const {
    connection,
    wallet,
    service,
    saveVault,
    setVaultLookupTable,
    isDemo,
  } = useApp();
  const demoEnabled = import.meta.env.DEV && isDemo;
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [uri, setUri] = useState("");
  const [metadataImage, setMetadataImage] = useState<File | null>(null);
  const [preparedMetadataImage, setPreparedMetadataImage] = useState<Awaited<
    ReturnType<typeof service.prepareMetadataImage>
  > | null>(null);
  const [preparingMetadataImage, setPreparingMetadataImage] = useState(false);
  const [metadataPreviewUrl, setMetadataPreviewUrl] = useState<string | null>(
    null
  );
  const imagePrepareGeneration = useRef(0);
  const previewUrlRef = useRef<string | null>(null);
  const [metadataDeliveryImageUri, setMetadataDeliveryImageUri] = useState<
    string | null
  >(null);
  const [uploadingMetadata, setUploadingMetadata] = useState(false);
  const [metadataUploadError, setMetadataUploadError] = useState<string | null>(
    null
  );
  // The creator chooses the 90% target; NEIRO is the fixed 10% leg. A
  // pick that collides with a fixed leg is merged rather than emitted as a
  // duplicate the program would reject with 6034.
  const [vaultPolicy, setVaultPolicy] = useState<VaultPolicy>(DEFAULT_POLICY);
  const [creatorMintOverride, setCreatorMintOverride] = useState<string | null>(
    null
  );
  const [mintKeypair] = useState<Keypair>(() => Keypair.generate());
  const [steps, setSteps] = useState<StepState[] | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    []
  );

  const mintAddress = mintKeypair.publicKey.toBase58();
  // The 90% pick defaults to the token being launched.
  const creatorMint = creatorMintOverride ?? mintAddress;
  const setCreatorMint = (value: string) => setCreatorMintOverride(value);
  const policy = buildPolicyLegs(creatorMint, vaultPolicy);
  const baseLegs: LegDraft[] = policyToLegs(policy);
  // KEYLESS reference binding. The own token's reference is its (future)
  // bonding curve — fully determined before launch; the fixed legs get the
  // live market scan.
  const refState = useLegReferences(baseLegs, { pendingMint: mintAddress });
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
  const admission = useAdmission(mintAddress, legs, {
    simulateOnChain: false, // the launch mint does not exist yet; the real
    // verdict runs atomically inside the setup transaction
    checkPumpCurve: false, // this flow only creates normal SOL-quoted launches
    pendingMint: mintAddress,
  });

  const vault = useMemo(() => {
    if (!refState.ready) return null;
    const parsed = legs.map((leg) => ({
      parsed: parseMint(leg.mint),
      bps: leg.bps,
      ref: leg.ref ? parseMint(leg.ref) ?? undefined : undefined,
    }));
    if (!parsed.length || parsed.some((leg) => !leg.parsed)) return null;
    try {
      return deriveSplitPda(
        mintKeypair.publicKey,
        parsed.map((leg) => ({ mint: leg.parsed!, bps: leg.bps, ref: leg.ref }))
      )[0].toBase58();
    } catch {
      return null;
    }
  }, [legs, mintKeypair, refState.ready]);

  const canRun =
    !!wallet &&
    !!vault &&
    refState.ready &&
    referencesAreSupported(baseLegs, refState) &&
    admission.clientPass &&
    !policy.error &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    (!metadataImage || !!preparedMetadataImage) &&
    !preparingMetadataImage &&
    !uploadingMetadata &&
    !running;

  const admissionFailure = [
    ...admission.shape,
    ...admission.targets.flatMap((target) => target.checks),
    ...(admission.curve?.checks ?? []),
  ].find((check) => check.status === "fail");
  const hasReferenceResult = baseLegs.every(
    (leg) => !!refState.byMint[leg.mint]
  );
  const referencesSupported = referencesAreSupported(baseLegs, refState);
  const readiness = preparingMetadataImage
    ? { text: "Compressing image on Cloudflare…", tone: "" }
    : uploadingMetadata
    ? { text: "Uploading final image and metadata…", tone: "" }
    : running
    ? { text: "Launching…", tone: "" }
    : !name.trim() || !symbol.trim()
    ? { text: "Add a name and symbol.", tone: "" }
    : policy.error
    ? { text: policy.error, tone: "err" }
    : refState.loading || !hasReferenceResult
    ? { text: "Checking burn targets…", tone: "" }
    : !referencesSupported
    ? { text: "Choose a supported burn target.", tone: "err" }
    : admission.loading
    ? { text: "Checking token rules…", tone: "" }
    : admissionFailure
    ? {
        text: `${admissionFailure.label}: ${admissionFailure.detail}`,
        tone: "err",
      }
    : !admission.clientPass
    ? { text: "This burn configuration cannot be launched.", tone: "err" }
    : !wallet
    ? { text: "Connect a wallet to launch.", tone: "" }
    : { text: "Ready to launch.", tone: "ok" };

  function chooseMetadataImage(file: File | null) {
    const generation = ++imagePrepareGeneration.current;
    setMetadataUploadError(null);
    setMetadataDeliveryImageUri(null);
    setPreparedMetadataImage(null);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setMetadataPreviewUrl(null);
    if (!file) {
      setMetadataImage(null);
      setPreparingMetadataImage(false);
      return;
    }
    if (!(METADATA_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setMetadataImage(null);
      setPreparingMetadataImage(false);
      setMetadataUploadError("Choose a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_METADATA_IMAGE_BYTES) {
      setMetadataImage(null);
      setPreparingMetadataImage(false);
      setMetadataUploadError(
        `The image must be ${Math.round(
          MAX_METADATA_IMAGE_BYTES / 1_000_000
        )} MB or smaller.`
      );
      return;
    }
    setMetadataImage(file);
    setPreparingMetadataImage(true);
    void (async () => {
      try {
        const prepared = await service.prepareMetadataImage(
          new Uint8Array(await file.arrayBuffer()),
          file.type as "image/png" | "image/jpeg" | "image/webp"
        );
        if (generation !== imagePrepareGeneration.current) return;
        const previewBytes = new Uint8Array(prepared.image);
        const previewUrl = URL.createObjectURL(
          new Blob([previewBytes.buffer], { type: prepared.imageContentType })
        );
        previewUrlRef.current = previewUrl;
        setPreparedMetadataImage(prepared);
        setMetadataPreviewUrl(previewUrl);
      } catch (error) {
        if (generation !== imagePrepareGeneration.current) return;
        setMetadataUploadError(
          String((error as Error).message ?? error).slice(0, 300)
        );
      } finally {
        if (generation === imagePrepareGeneration.current) {
          setPreparingMetadataImage(false);
        }
      }
    })();
  }

  // Cloudflare normalization happens as soon as the image is selected. Irys
  // writes are permanent and cost real money, so both the image and metadata
  // are uploaded there only when the user presses Launch. The latest editable
  // fields are frozen into that final JSON at that moment.
  async function uploadMetadata(fields: {
    name: string;
    symbol: string;
    description: string;
    website: string;
    twitter: string;
    telegram: string;
  }): Promise<string | null> {
    if (!preparedMetadataImage || !fields.name || !fields.symbol) return null;
    setUploadingMetadata(true);
    setMetadataUploadError(null);
    try {
      const receipt = await service.uploadMetadata({
        name: fields.name,
        symbol: fields.symbol,
        description: fields.description,
        links: {
          ...(fields.website ? { website: fields.website } : {}),
          ...(fields.twitter ? { twitter: fields.twitter } : {}),
          ...(fields.telegram ? { telegram: fields.telegram } : {}),
        },
        image: preparedMetadataImage.image,
        imageContentType: preparedMetadataImage.imageContentType,
      });
      setUri(receipt.uri);
      setMetadataDeliveryImageUri(receipt.deliveryImageUri);
      return receipt.uri;
    } catch (error) {
      setMetadataUploadError(
        String((error as Error).message ?? error).slice(0, 300)
      );
      return null;
    } finally {
      setUploadingMetadata(false);
    }
  }

  async function run() {
    if (!wallet || !vault || !refState.ready) return;
    // Freeze the complete immutable configuration before any irreversible
    // upload or wallet prompt. React may re-render while Irys/RPC calls are in
    // flight; no later read is allowed to substitute a new reference or PDA.
    const snapshotFields = Object.freeze({
      name: name.trim(),
      symbol: symbol.trim(),
      description: description.trim(),
      website: website.trim(),
      twitter: twitter.trim(),
      telegram: telegram.trim(),
    });
    const snapshotLegs = legs.map((leg) =>
      Object.freeze({
        mint: leg.mint,
        bps: leg.bps,
        ...(leg.ref ? { ref: leg.ref } : {}),
        referenceBlock: leg.referenceBlock
          ? Object.freeze({ ...leg.referenceBlock })
          : undefined,
      })
    );
    const parsedLegs = snapshotLegs.map((leg) => ({
      mint: parseMint(leg.mint)!,
      bps: leg.bps,
      ref: leg.ref ? parseMint(leg.ref)! : undefined,
    }));
    const [pda] = deriveSplitPda(mintKeypair.publicKey, parsedLegs);
    const snapshotVault = pda.toBase58();
    if (snapshotVault !== vault) {
      setMetadataUploadError(
        "the displayed vault changed before launch; review the frozen configuration and retry"
      );
      return;
    }
    setRunning(true);
    const plan: StepState[] = [
      {
        label: `create_v2 — launch ${snapshotFields.symbol} on Pump`,
        status: "running",
      },
      { label: "setup", status: "idle" },
    ];
    setSteps([...plan]);
    try {
      // Pump create_v2 deterministically creates the pending mint under
      // Token-2022. Resolve that known owner now so every setup instruction is
      // finalized before the first wallet prompt.
      const resolved = (
        await resolveLegs(connection, pda, parsedLegs, new Set([mintAddress]))
      ).map((leg, i) => ({
        ...leg,
        referenceBlock: snapshotLegs[i].referenceBlock,
      }));
      const validateA = buildValidateConfigModeA(
        pda,
        mintKeypair.publicKey,
        resolved,
        splitAmounts(
          PROBE_TOTAL_LAMPORTS,
          resolved.map((leg) => leg.bps)
        )
      );
      const ataIxs = buildAtaInstructions(wallet.publicKey, pda, resolved);
      const feeShareIxs = await buildFeeShareInstructions({
        creator: wallet.publicKey,
        mint: mintKeypair.publicKey,
        vault: pda,
      });
      if (!validateA.keys[0]?.pubkey.equals(pda)) {
        throw new Error("validate_config was not built for the frozen vault");
      }
      const pdaBytes = Buffer.from(pda.toBytes());
      if (!feeShareIxs.some((ix) => Buffer.from(ix.data).includes(pdaBytes))) {
        throw new Error("Pump fee share was not encoded for the frozen vault");
      }
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

      let finalMetadataUri = uri.trim();
      if (metadataImage) {
        const uploadedUri = await uploadMetadata(snapshotFields);
        if (!uploadedUri) {
          plan[0] = {
            ...plan[0],
            status: "failed",
            detail: "metadata upload failed; no transaction was signed",
          };
          setSteps([...plan]);
          setRunning(false);
          return;
        }
        finalMetadataUri = uploadedUri;
      }
      const createIx = await buildCreateV2Instruction({
        mint: mintKeypair.publicKey,
        name: snapshotFields.name,
        symbol: snapshotFields.symbol,
        uri: finalMetadataUri,
        creator: wallet.publicKey,
      });
      // SURFPOOL DIVERGENCE (2026-08-26, demo only): a fresh fork's runtime
      // rejects Pump's create_v2 with InsufficientFundsForRent on the new
      // Token-2022 metadata mint (~3.0-3.5M lamports short after the TLV
      // metadata realloc), while mainnet accepts the identical transaction —
      // Pump launches land there continuously. Pre-funding the mint address
      // in the SAME transaction clears the post-transaction rent check.
      // Never on mainnet: the top-up would be lamports locked in the mint.
      const createIxs = demoEnabled
        ? [
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: mintKeypair.publicKey,
              lamports: 5_000_000,
            }),
            createIx,
          ]
        : [createIx];
      const createSig = await sendWithWallet(connection, wallet, createIxs, [
        mintKeypair,
      ]);
      plan[0] = { ...plan[0], status: "done", signature: createSig };
      setSteps([...plan]);
      plan.splice(
        1,
        1,
        ...setupPlan.transactions.map((tx) => ({
          label: `${tx.label} — ${tx.bytes} bytes`,
          status: "idle" as const,
        }))
      );
      for (let i = 0; i < setupPlan.transactions.length; i++) {
        plan[1 + i] = { ...plan[1 + i], status: "running" };
        setSteps([...plan]);
        const signature = await sendWithWallet(
          connection,
          wallet,
          setupPlan.transactions[i].instructions,
          [],
          setupPlan.transactions[i].lookupTables
        );
        plan[1 + i] = { ...plan[1 + i], status: "done", signature };
        setSteps([...plan]);
      }
      // The tested 90/10 two-leg policy lands without a per-vault lookup table
      // through the quote service's maxAccounts fitting ladder. Keep automatic
      // lookup-table creation only for larger custom configurations.
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
            launchMint: mintKeypair.publicKey,
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
      saveVault({
        label: snapshotFields.symbol,
        launchMint: mintAddress,
        legs: snapshotLegs.map(({ mint, bps, ref }) => ({ mint, bps, ref })),
        vault: snapshotVault,
        createdAt: Date.now(),
        feeShare: true,
      });
      navigate({
        to: "/vault",
        search: {
          launch: mintAddress,
          legs: legsToParam(snapshotLegs),
          label: snapshotFields.symbol,
        },
      });
    } catch (error) {
      const failedIndex = plan.findIndex((s) => s.status === "running");
      const at = failedIndex >= 0 ? failedIndex : plan.length - 1;
      const detail =
        error instanceof SetupError
          ? `${error.message}${
              error.attribution.code !== undefined &&
              ERROR_EXPLANATIONS[error.attribution.code]
                ? ` — ${ERROR_EXPLANATIONS[error.attribution.code]}`
                : ""
            }`
          : String((error as Error).message ?? error).slice(0, 300);
      plan[at] = { ...plan[at], status: "failed", detail };
      setSteps([...plan]);
      setRunning(false);
    }
  }

  return (
    <main className="launch-page">
      <header className="hero-copy launch-hero">
        <h1>Launch a token</h1>
        <p>Creator fees buy and burn your token picks, forever.</p>
      </header>

      <div className="launch-flow">
        <section className="launch-step" aria-labelledby="launch-step-token">
          <span className="launch-step-number">1</span>
          <div className="launch-step-body">
            <div className="launch-step-head">
              <h2 id="launch-step-token">Your token</h2>
            </div>
            <div className="token-fields">
              <label className="field">
                <span className="name">Name</span>
                <input
                  type="text"
                  value={name}
                  maxLength={32}
                  placeholder="My Token"
                  onChange={(event) => setName(event.target.value)}
                  disabled={running || uploadingMetadata}
                />
              </label>
              <label className="field">
                <span className="name">Symbol</span>
                <input
                  type="text"
                  value={symbol}
                  maxLength={10}
                  placeholder="MYTKN"
                  onChange={(event) =>
                    setSymbol(event.target.value.toUpperCase())
                  }
                  disabled={running || uploadingMetadata}
                />
              </label>
              <label className="field token-description">
                <span className="name">Description (optional)</span>
                <textarea
                  value={description}
                  maxLength={500}
                  placeholder="What is your token about?"
                  onChange={(event) => setDescription(event.target.value)}
                  disabled={running || uploadingMetadata}
                />
              </label>
              <label className="field">
                <span className="name">Website (optional)</span>
                <input
                  type="url"
                  value={website}
                  maxLength={200}
                  placeholder="https://yourtoken.com"
                  onChange={(event) => setWebsite(event.target.value)}
                  disabled={running || uploadingMetadata}
                />
              </label>
              <label className="field">
                <span className="name">X (optional)</span>
                <input
                  type="url"
                  value={twitter}
                  maxLength={200}
                  placeholder="https://x.com/yourtoken"
                  onChange={(event) => setTwitter(event.target.value)}
                  disabled={running || uploadingMetadata}
                />
              </label>
              <label className="field">
                <span className="name">Telegram (optional)</span>
                <input
                  type="url"
                  value={telegram}
                  maxLength={200}
                  placeholder="https://t.me/yourtoken"
                  onChange={(event) => setTelegram(event.target.value)}
                  disabled={running || uploadingMetadata}
                />
              </label>
              <div className="metadata-upload">
                <label className="field metadata-image">
                  <span className="name">Upload image and metadata</span>
                  <input
                    type="file"
                    accept={METADATA_IMAGE_TYPES.join(",")}
                    onChange={(event) =>
                      chooseMetadataImage(event.target.files?.[0] ?? null)
                    }
                    disabled={running || uploadingMetadata}
                  />
                </label>
                <div className="metadata-upload-action">
                  {metadataImage && (
                    <span title={metadataImage.name}>
                      {metadataImage.name} ·{" "}
                      {metadataImage.size.toLocaleString()} bytes
                      {preparingMetadataImage
                        ? " · compressing on Cloudflare…"
                        : preparedMetadataImage
                        ? ` · ${preparedMetadataImage.imageBytes.toLocaleString()} bytes ready — Irys finalizes on Launch`
                        : " · image preparation failed"}
                    </span>
                  )}
                </div>
                {metadataUploadError && (
                  <p className="metadata-upload-error" role="alert">
                    {metadataUploadError}
                  </p>
                )}
                {(metadataDeliveryImageUri || metadataPreviewUrl) && (
                  <img
                    className="metadata-upload-preview"
                    src={metadataDeliveryImageUri || metadataPreviewUrl || ""}
                    alt={`${name.trim() || symbol.trim()} token icon`}
                  />
                )}
              </div>
              <label className="field token-uri">
                <span className="name">Metadata URI (optional)</span>
                <input
                  type="text"
                  value={uri}
                  placeholder="https://…/token.json"
                  onChange={(event) => setUri(event.target.value)}
                  disabled={running || uploadingMetadata}
                />
              </label>
            </div>
          </div>
        </section>

        <section className="launch-step" aria-labelledby="launch-step-burn">
          <span className="launch-step-number">2</span>
          <div className="launch-step-body">
            <div className="launch-step-head">
              <h2 id="launch-step-burn">What to burn</h2>
            </div>
            <p className="sub launch-support-note">
              Pump and supported Raydium AMM tokens can be bought and burned.
              Selected CLMM and DLMM tokens qualify when their pools are deep
              and established. Meteora DAMM v1 and v2 are not yet supported.
            </p>
            <PolicyPicker
              policy={vaultPolicy}
              onPolicyChange={setVaultPolicy}
              creatorMint={creatorMint}
              onChange={setCreatorMint}
              ownTokenMint={mintAddress}
              ownTokenName={name}
              ownTokenSymbol={symbol}
              deferSummary
              disabled={running}
            />
            <ReferencePanel
              legs={baseLegs}
              state={refState}
              labels={{
                [mintAddress]: symbol.trim() || name.trim() || "New token",
              }}
              hierarchy={{
                creatorMint,
                creatorBps: vaultPolicy.creatorBps,
                fixedLegs: vaultPolicy.fixedLegs,
                pendingMint: mintAddress,
                primaryName: creatorMint === mintAddress ? name : undefined,
                primarySymbol: creatorMint === mintAddress ? symbol : undefined,
              }}
            />
          </div>
        </section>

        <section
          className="launch-step launch-action"
          aria-labelledby="launch-step-submit"
        >
          <span className="launch-step-number">3</span>
          <div className="launch-step-body">
            <div className="launch-step-head">
              <h2 id="launch-step-submit">Launch</h2>
              {vault && (
                <span className="launch-vault">
                  Vault <code title={vault}>{shortAddress(vault, 6)}</code>
                  <CopyButton value={vault} />
                </span>
              )}
            </div>
            <p className={`launch-readiness ${readiness.tone}`}>
              {readiness.text}
            </p>
            <button
              className="btn primary launch-button"
              disabled={!canRun}
              onClick={run}
            >
              {preparingMetadataImage
                ? "Preparing image…"
                : uploadingMetadata
                ? "Uploading metadata…"
                : running
                ? "Launching…"
                : "Launch token"}
            </button>
            <p className="launch-approval-note">
              Expect 2 wallet approvals: one creates the Pump token and one
              atomically validates and sets up its burn vault. If the setup
              exceeds Solana&apos;s 1,232-byte transaction limit, it is safely
              split and needs a third approval.
            </p>
            {steps && (
              <div className="launch-progress">
                <TxSteps steps={steps} />
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
