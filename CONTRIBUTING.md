# Contributing to 2Code

2Code is a fork of [1Code](https://github.com/21st-dev/1code) by 21st.dev.

## Building from Source

Prerequisites: Bun, Python 3.11+, Xcode Command Line Tools (macOS)

```bash
bun install
bun run claude:download  # Download Claude CLI binary (required)
bun run dev              # Development with hot reload
bun run build            # Production build
bun run package:mac      # Create distributable (or package:win, package:linux)
```

## Contributing

Issues and pull requests are welcome. Direct commit access to `main` is restricted to the maintainer.

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a PR

## License

Apache 2.0 - see [LICENSE](LICENSE) for details.
