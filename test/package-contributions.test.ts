import { describe, expect, test } from "bun:test";

interface ExtensionPackage {
  description?: string;
  devDependencies?: Record<string, string>;
  displayName?: string;
  license?: string;
  publisher?: string;
  scripts?: Record<string, string>;
  version?: string;
  contributes?: {
    commands?: Array<{
      category?: string;
      command?: string;
      enablement?: string;
      icon?: string;
      title?: string;
    }>;
    menus?: Record<string, Array<{ command?: string; group?: string; when?: string }>>;
  };
}

describe("extension contributions", () => {
  test("exposes Restore Diff Settings in the Command Palette", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;

    expect(
      extensionPackage.contributes?.commands?.find(
        (command) => command.command === "inlinediff.restoreDiffSettings",
      ),
    ).toMatchObject({
      category: "Inline Diff",
      title: "Restore Diff Settings",
    });
    // Must NOT be hidden from Command Palette
    const commandPaletteItems = extensionPackage.contributes?.menus?.commandPalette ?? [];
    expect(commandPaletteItems).not.toContainEqual({
      command: "inlinediff.restoreDiffSettings",
      when: "false",
    });
  });

  test("shows Initialize only while an uninitialized workspace folder exists", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;

    expect(
      extensionPackage.contributes?.commands?.find(
        (command) => command.command === "inlinediff.initialize",
      ),
    ).toMatchObject({
      enablement: "inlinediff.canInitialize",
    });
    expect(
      extensionPackage.contributes?.menus?.["view/title"]?.find(
        (item) => item.command === "inlinediff.initialize",
      ),
    ).toMatchObject({
      when: "view == inlinediff.changedFiles && inlinediff.canInitialize",
    });
    expect(
      extensionPackage.contributes?.menus?.commandPalette?.find(
        (item) => item.command === "inlinediff.initialize",
      ),
    ).toMatchObject({
      when: "inlinediff.canInitialize",
    });
  });

  test("shows next/previous change buttons only on Inline Diff editors", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;

    const editorTitleItems = extensionPackage.contributes?.menus?.["editor/title"] ?? [];
    expect(editorTitleItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "workbench.action.compareEditor.previousChange",
          group: "navigation@1",
          when: "resourceScheme == inlinediff-current",
        }),
        expect.objectContaining({
          command: "workbench.action.compareEditor.nextChange",
          group: "navigation@2",
          when: "resourceScheme == inlinediff-current",
        }),
      ]),
    );
  });

  test("shows file actions for binary-modified changed file entries", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;

    const fileActionItems = extensionPackage.contributes?.menus?.["view/item/context"]?.filter(
      (item) =>
        item.command === "inlinediff.acceptFile" || item.command === "inlinediff.rejectFile",
    );

    expect(fileActionItems).toHaveLength(2);
    expect(fileActionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "inlinediff.acceptFile",
          when: "view == inlinediff.changedFiles && viewItem =~ /inlinediff\\.(added|modified|deleted|binary-modified)/",
        }),
        expect.objectContaining({
          command: "inlinediff.rejectFile",
          when: "view == inlinediff.changedFiles && viewItem =~ /inlinediff\\.(added|modified|deleted|binary-modified)/",
        }),
      ]),
    );
  });

  test("hides context-only commands from the Command Palette", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;

    const commandPaletteItems = extensionPackage.contributes?.menus?.commandPalette ?? [];
    const contextOnlyCommands = [
      "inlinediff.openDiff",
      "inlinediff.acceptFile",
      "inlinediff.rejectFile",
      "inlinediff.acceptHunk",
      "inlinediff.rejectHunk",
      "inlinediff.toggleKeepHunk",
      "inlinediff.acceptUnkeptHunks",
      "inlinediff.acceptAll",
      "inlinediff.rejectAll",
    ];

    for (const command of contextOnlyCommands) {
      expect(commandPaletteItems).toContainEqual({ command, when: "false" });
    }
  });

  test("uses inline change wording for user-facing command titles", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;

    expect(
      extensionPackage.contributes?.commands?.filter((command) =>
        [
          "inlinediff.acceptHunk",
          "inlinediff.rejectHunk",
          "inlinediff.toggleKeepHunk",
          "inlinediff.acceptUnkeptHunks",
        ].includes(command.command ?? ""),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "inlinediff.acceptHunk",
          title: "Accept Inline Change",
        }),
        expect.objectContaining({
          command: "inlinediff.rejectHunk",
          title: "Reject Inline Change",
        }),
        expect.objectContaining({
          command: "inlinediff.toggleKeepHunk",
          title: "Toggle Keep Inline Change",
        }),
        expect.objectContaining({
          command: "inlinediff.acceptUnkeptHunks",
          title: "Accept Inline Changes Not Kept For Review",
        }),
      ]),
    );
  });

  test("namespaces commands via category, not a title prefix, and gives tree buttons icons", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;

    const commands = extensionPackage.contributes?.commands ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.category).toBe("Inline Diff");
      expect(command.title?.startsWith("Inline Diff")).toBe(false);
    }

    // Every command surfaced as a tree button (view/title or view/item/context)
    // needs an icon so it renders icon-only with the title as its tooltip.
    const menus = extensionPackage.contributes?.menus ?? {};
    const buttonCommandIds = new Set(
      [...(menus["view/title"] ?? []), ...(menus["view/item/context"] ?? [])]
        .map((item) => item.command)
        .filter((id): id is string => id !== undefined),
    );
    for (const id of buttonCommandIds) {
      const command = commands.find((entry) => entry.command === id);
      expect(command?.icon).toBeDefined();
    }
  });

  test("shows accept-unkept on project and text file entries", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;

    const acceptUnkeptItems = extensionPackage.contributes?.menus?.["view/item/context"]?.filter(
      (item) => item.command === "inlinediff.acceptUnkeptHunks",
    );

    expect(acceptUnkeptItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "inlinediff.acceptUnkeptHunks",
          when: "view == inlinediff.changedFiles && viewItem == inlinediff.project",
        }),
        expect.objectContaining({
          command: "inlinediff.acceptUnkeptHunks",
          when: "view == inlinediff.changedFiles && viewItem =~ /inlinediff\\.(added|modified|deleted)/",
        }),
      ]),
    );
  });
});

describe("extension release packaging", () => {
  test("declares local VSIX release metadata and Bun package scripts", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;

    expect(extensionPackage).toMatchObject({
      description:
        "Control workspace file changes against an accepted baseline before they become Git history.",
      displayName: "Inline Diff",
      license: "MIT OR Apache-2.0",
      publisher: "freeslur",
      version: "0.1.1",
    });
    expect(extensionPackage.devDependencies).toHaveProperty("@vscode/vsce");
    expect(extensionPackage.scripts).toMatchObject({
      "check-package": "bun run build && bunx vsce ls --tree",
      package: "bun run scripts/package.ts",
      "release:local": "bun run check && bun run package && bunx vsce ls --tree",
      "release:marketplace:dry-run": "bun run release:local",
      test: "bun test --timeout 15000",
    });
  });

  test("keeps package policy files in sync with the manifest", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;
    const licenseText = await Bun.file(`${import.meta.dir}/../LICENSE`).text();
    const mitLicenseText = await Bun.file(`${import.meta.dir}/../LICENSE-MIT`).text();
    const apacheLicenseText = await Bun.file(`${import.meta.dir}/../LICENSE-APACHE`).text();
    const changelogText = await Bun.file(`${import.meta.dir}/../CHANGELOG.md`).text();
    const supportText = await Bun.file(`${import.meta.dir}/../SUPPORT.md`).text();

    expect(licenseText).toContain("MIT OR Apache-2.0");
    expect(mitLicenseText).toStartWith("MIT License");
    expect(apacheLicenseText).toStartWith("Apache License");
    expect(changelogText).toContain("# Changelog");
    expect(changelogText).toContain(`## ${extensionPackage.version}`);
    expect(supportText).toContain("# Support");
  });

  test("keeps README local VSIX commands aligned with the manifest version", async () => {
    const extensionPackage = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as ExtensionPackage;
    const readmeText = await Bun.file(`${import.meta.dir}/../README.md`).text();

    expect(readmeText).toContain(`dist/inlinediff-${extensionPackage.version}.vsix`);
    expect(readmeText).toContain(
      `code --install-extension dist/inlinediff-${extensionPackage.version}.vsix`,
    );
  });

  test("does not point README users to unpublished docs", async () => {
    const readmeText = await Bun.file(`${import.meta.dir}/../README.md`).text();

    expect(readmeText).not.toContain("docs/");
  });

  test("uses a dedicated Marketplace README during packaging", async () => {
    const packageScriptText = await Bun.file(`${import.meta.dir}/../scripts/package.ts`).text();
    const marketplaceReadmeText = await Bun.file(`${import.meta.dir}/../MARKETPLACE.md`).text();
    const vscodeignoreText = await Bun.file(`${import.meta.dir}/../.vscodeignore`).text();

    expect(packageScriptText).toContain("MARKETPLACE.md");
    expect(packageScriptText).toContain("README.md");
    expect(packageScriptText).toContain("finally");
    expect(marketplaceReadmeText).toContain("<!-- marketplace-readme -->");
    expect(marketplaceReadmeText).toContain(
      "https://raw.githubusercontent.com/freeslur/inlinediff/main/media/icon.png",
    );
    expect(marketplaceReadmeText).toContain(
      "https://raw.githubusercontent.com/freeslur/inlinediff/main/media/inline-diff-screenshot.png",
    );
    expect(marketplaceReadmeText).not.toContain('src="media/');
    expect(marketplaceReadmeText).not.toContain("Build and install the VSIX locally");
    expect(marketplaceReadmeText).not.toContain("Contributing");
    expect(vscodeignoreText).not.toContain("!MARKETPLACE.md");
  });

  test("publishes public GitHub snapshots through the public ignore policy", async () => {
    const publishScriptText = await Bun.file(
      `${import.meta.dir}/../scripts/github-publish.ps1`,
    ).text();
    const publicIgnoreText = await Bun.file(`${import.meta.dir}/../.gitignore-public`).text();

    expect(publicIgnoreText).toContain(".gitignore-public");
    expect(publicIgnoreText).toContain("docs/");
    expect(publicIgnoreText).toContain("*.md");
    expect(publicIgnoreText).toContain("!README.md");
    expect(publishScriptText).toContain(".gitignore-public");
    expect(publishScriptText).toContain("GIT_INDEX_FILE");
    expect(publishScriptText).toContain("read-tree");
    expect(publishScriptText).toContain("ls-files");
    expect(publishScriptText).toContain("--exclude-from");
    expect(publishScriptText).toContain("write-tree");
    expect(publishScriptText).not.toContain('rev-parse "HEAD^{tree}"');
  });

  test("initializes GitHub publishing through the GitHub CLI with install guidance", async () => {
    const initScriptText = await Bun.file(`${import.meta.dir}/../scripts/github-init.ps1`).text();

    expect(initScriptText).toContain("private");
    expect(initScriptText).toContain("public");
    expect(initScriptText).toContain(".gitignore-public");
    expect(initScriptText).toContain("Get-Command gh");
    expect(initScriptText).toContain("C:\\Program Files\\GitHub CLI\\gh.exe");
    expect(initScriptText).toContain("winget install --id GitHub.cli -e");
    expect(initScriptText).toContain("gh auth status");
    expect(initScriptText).toContain("gh repo view");
    expect(initScriptText).toContain("gh repo create");
    expect(initScriptText).not.toContain("Get-Command winget");
    expect(initScriptText).not.toContain("checkout --orphan");
    expect(initScriptText).not.toContain("git commit");
  });

  test("keeps public README artwork packageable", async () => {
    const readmeText = await Bun.file(`${import.meta.dir}/../README.md`).text();
    const marketplaceReadmeText = await Bun.file(`${import.meta.dir}/../MARKETPLACE.md`).text();

    expect(await Bun.file(`${import.meta.dir}/../media/inline-diff-screenshot.png`).exists()).toBe(
      true,
    );
    expect(readmeText).toContain("media/icon.png");
    expect(readmeText).toContain("media/inline-diff-screenshot.png");
    expect(readmeText).toContain("https://github.com/freeslur/inlinediff/blob/main/README.ko.md");
    expect(marketplaceReadmeText).toContain(
      "https://raw.githubusercontent.com/freeslur/inlinediff/main/media/inline-diff-screenshot.png",
    );
  });

  test("uses .diffignore as the repository ignore policy filename", async () => {
    expect(await Bun.file(`${import.meta.dir}/../.diffignore`).exists()).toBe(true);
    expect(await Bun.file(`${import.meta.dir}/../.liffignore`).exists()).toBe(false);
  });

  test("documents .diffignore in the README", async () => {
    const readmeText = await Bun.file(`${import.meta.dir}/../README.md`).text();

    expect(readmeText).toContain(".diffignore");
  });

  test("documents the current large text file tracking limit", async () => {
    const readmeText = await Bun.file(`${import.meta.dir}/../README.md`).text();

    expect(readmeText).toContain("Text files larger than 2 MiB are excluded from diff tracking.");
  });

  test("excludes development, local state, and evidence files from the VSIX", async () => {
    const ignoreText = await Bun.file(`${import.meta.dir}/../.vscodeignore`).text();
    const ignorePatterns = ignoreText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(ignorePatterns).toEqual(
      expect.arrayContaining([
        ".git/**",
        ".gitignore",
        ".inlinediff/**",
        ".agents/**",
        ".claude/**",
        ".vscode/**",
        "src/**",
        "test/**",
        "docs/**",
        "scripts/**",
        "node_modules/**",
        "*.vsix",
        "bun.lock",
        "biome.json",
        "tsconfig.json",
        "*.md",
        "!README.md",
        "!CHANGELOG.md",
        "!SUPPORT.md",
        ".diffignore",
      ]),
    );
    // All Markdown is excluded except the three allow-listed files — no per-file
    // honest-listing of internal docs, so new design notes can never leak.
    expect(ignorePatterns).not.toContain("AGENTS.md");
    expect(ignorePatterns).not.toContain("README.ko.md");
    expect(ignorePatterns).not.toContain(".liffignore");
    expect(ignorePatterns).not.toContain("dist/**");
    expect(ignorePatterns).not.toContain("media/**");
    expect(ignorePatterns).not.toContain("package.json");
    expect(ignorePatterns).not.toContain("README.md");
    expect(ignorePatterns).not.toContain("LICENSE");
    expect(ignorePatterns).not.toContain("LICENSE-MIT");
    expect(ignorePatterns).not.toContain("LICENSE-APACHE");
    expect(ignorePatterns).not.toContain("CHANGELOG.md");
    expect(ignorePatterns).not.toContain("SUPPORT.md");
  });

  test("excludes Inline Diff local state from workspace quality tools", async () => {
    const biomeConfig = (await Bun.file(`${import.meta.dir}/../biome.json`).json()) as {
      files?: { includes?: string[] };
    };
    const tsconfig = (await Bun.file(`${import.meta.dir}/../tsconfig.json`).json()) as {
      exclude?: string[];
    };

    expect(biomeConfig.files?.includes).toContain("!.inlinediff");
    expect(tsconfig.exclude).toContain(".inlinediff");
  });
});
