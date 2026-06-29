import { reinitializeProject } from "./diff-service/project-initializer.ts";
import { readProjectMetadata } from "./diff-service/project-metadata.ts";
import { projectTrustKey, type TrustedStoreStorage, trustProjectStore } from "./project-trust.ts";

export const untrustedStoreChoices = {
  ignore: "Ignore",
  reinitialize: "Reinitialize",
  reuseExisting: "Reuse Existing",
} as const;

export type UntrustedStoreChoice =
  (typeof untrustedStoreChoices)[keyof typeof untrustedStoreChoices];

export interface UntrustedStoreMessages {
  showErrorMessage(message: string): PromiseLike<unknown>;
  showInformationMessage(message: string): PromiseLike<unknown>;
  showWarningMessage(
    message: string,
    options: { readonly modal: true },
    ...items: UntrustedStoreChoice[]
  ): PromiseLike<UntrustedStoreChoice | undefined>;
}

export interface ResolveUntrustedProjectStoreOptions {
  readonly ignoredStoreKeys: Set<string>;
  readonly messages: UntrustedStoreMessages;
  readonly rootPath: string;
  readonly storage: TrustedStoreStorage;
}

export async function resolveUntrustedProjectStore({
  ignoredStoreKeys,
  messages,
  rootPath,
  storage,
}: ResolveUntrustedProjectStoreOptions): Promise<boolean> {
  const choice = await messages.showWarningMessage(
    `Inline Diff found an existing store that is not trusted by this editor: ${rootPath}. Choose Reinitialize to create a new local trusted store, Reuse Existing only if you trust this workspace and its existing Inline Diff baseline, or Ignore to keep Inline Diff disabled here.`,
    { modal: true },
    untrustedStoreChoices.reinitialize,
    untrustedStoreChoices.reuseExisting,
    untrustedStoreChoices.ignore,
  );

  switch (choice) {
    case untrustedStoreChoices.ignore:
      ignoredStoreKeys.add(projectTrustKey(rootPath));
      return false;
    case untrustedStoreChoices.reinitialize:
      await trustProjectStore(storage, rootPath, await reinitializeProject(rootPath));
      await messages.showInformationMessage(`Inline Diff reinitialized: ${rootPath}`);
      return true;
    case untrustedStoreChoices.reuseExisting:
      return trustExistingStore(storage, rootPath, messages);
    case undefined:
      ignoredStoreKeys.add(projectTrustKey(rootPath));
      return false;
  }
}

async function trustExistingStore(
  storage: TrustedStoreStorage,
  rootPath: string,
  messages: UntrustedStoreMessages,
): Promise<boolean> {
  const metadata = await readProjectMetadata(rootPath);
  if (metadata === undefined) {
    await messages.showErrorMessage(
      `Inline Diff cannot reuse this store because its project metadata is missing or invalid: ${rootPath}`,
    );
    return false;
  }

  await trustProjectStore(storage, rootPath, metadata.storeId);
  await messages.showInformationMessage(`Inline Diff trusted existing store: ${rootPath}`);
  return true;
}
