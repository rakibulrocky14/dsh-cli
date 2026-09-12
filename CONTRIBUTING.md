# 🤝 Contributing to dsh-cli

First off, thank you for considering contributing to **`dsh-cli`**! 🎉

Whether you're fixing a bug, adding new features, improving documentation, or experimenting with new terminal surfaces for DeepSeek Harness, **all contributions and pull requests are welcome!**

---

## 🌟 Ways to Contribute

You can contribute to `dsh-cli` in many different ways:

- 🐛 **Report Bugs**: Encounter an issue, freeze, or display glitch? Open an issue with details.
- 💡 **Suggest Enhancements**: Have ideas to make the terminal experience cleaner or faster? Let us know.
- 📖 **Improve Documentation**: Found typos, missing steps, or have tips to share? Documentation PRs are always appreciated.
- 🛠️ **Submit Pull Requests**: Implement bug fixes, add features, or write new test cases.

---

## 🚀 Getting Started with Local Development

### Prerequisites

- **Node.js**: `^22.19 || >=24`
- **npm** or **pnpm**
- **Git**
- **DeepSeek Harness (`dsh`)** installed on your system (optional for testing unit components, required for end-to-end testing)

### Setting Up Your Environment

1. **Fork the repository** on GitHub:
   Click the **Fork** button at [https://github.com/rakibulrocky14/dsh-cli](https://github.com/rakibulrocky14/dsh-cli).

2. **Clone your fork**:
   ```bash
   git clone https://github.com/<your-username>/dsh-cli.git
   cd dsh-cli
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Build the project**:
   ```bash
   npm run build
   ```

5. **Run the test suite**:
   ```bash
   npm test
   ```

---

## 🧪 Testing & Verification

We maintain a fast and comprehensive unit test suite covering the TUI engine, Ink frames, session browser, markdown parsing, and live streaming overlays.

Before submitting your pull request, please ensure all checks pass:

```bash
# Typecheck TypeScript
npm run typecheck

# Build TypeScript to lib/
npm run build

# Run all test suites
npm test
```

If you are introducing new logic or fixing a bug, please add corresponding test cases in `tests/`.

---

## 📁 Project Architecture

- **`src/tui/`**: Ink React UI components (`app.tsx`, `widgets.tsx`, `engine.ts`, `mouse.ts`).
- **`src/core/`**: DSH service facade (`dsh.ts`), durable log projection (`transcript.ts`), message factories (`messages.ts`), and command parsers (`commands.ts`).
- **`src/repl.ts`**: Fallback line-oriented REPL surface for CI, pipes, or non-TTY environments.
- **`src/print.ts`**: One-shot execution surface for `--print "<task>"`.
- **`src/startup.ts`**: Command-line flag parsing and startup hook.
- **`cordis.patch.yml`**: Cordis plugin manifest injecting runner and startup services into DSH.

---

## 🔀 Pull Request Process

1. **Create a branch**:
   ```bash
   git checkout -b feature/my-feature
   # or
   git checkout -b fix/issue-description
   ```

2. **Make your changes**:
   - Keep code readable and well-typed.
   - Preserve backward compatibility with `@deepseek-ai/dsh-base`.

3. **Commit your changes**:
   - Write clear, concise commit messages (e.g. `feat: add custom theme support` or `fix: handle terminal resize without flicker`).

4. **Push to your fork**:
   ```bash
   git push origin feature/my-feature
   ```

5. **Open a Pull Request**:
   - Go to [https://github.com/rakibulrocky14/dsh-cli/pulls](https://github.com/rakibulrocky14/dsh-cli/pulls) and click **New Pull Request**.
   - Describe what changed and include steps to verify your changes.

---

## 💬 Code of Conduct & Community

Please treat everyone with respect and kindness:
- Be welcoming, inclusive, and collaborative.
- Provide constructive feedback during reviews.
- Focus on what is best for the community and users.

---

Thank you for helping make `dsh-cli` awesome! 🚀
