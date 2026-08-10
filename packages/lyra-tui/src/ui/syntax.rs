//! Fenced-code syntax highlighting.
//!
//! # Why not syntect / tree-sitter
//!
//! DESIGN.md §3 asks for highlighted fenced code with no runtime grammar
//! fetching. Both obvious answers cost far more than the output is worth here:
//! syntect drags in a regex engine, a plist parser and a two-megabyte binary
//! syntax dump; tree-sitter needs a C grammar per language and `unsafe`, which
//! this crate forbids. Both exist to produce a *precise parse tree* — and the
//! terminal then throws almost all of it away, because the theme has exactly
//! six syntax tokens (keyword, string, number, comment, type, function) and two
//! accents to spend on them.
//!
//! So this is a **scanner, not a parser**: one shared tokenizer driven by a
//! per-language table of keywords, comment markers and string delimiters. It is
//! ~200 lines, has no dependencies, cannot fetch anything, and is wrong only in
//! ways that are invisible at six colours. Adding a language is adding a row to
//! [`LANGUAGES`].
//!
//! # The streaming constraint
//!
//! [`highlight_line`] carries state *forwards only*: a block comment or a raw
//! string opened on line 3 affects line 4, never line 2. That is what lets
//! [`super::markdown`] commit code lines to scrollback as they arrive instead
//! of holding the whole fence back until it closes.

use crate::theme::{Color, Theme};
use crate::ui::{Span, Style};

/// A highlighted token class. Exactly the six the theme carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    /// Anything not otherwise classified.
    Plain,
    /// Language keyword.
    Keyword,
    /// String or char literal.
    String,
    /// Numeric literal.
    Number,
    /// Comment.
    Comment,
    /// Type-ish identifier (capitalised, or a primitive type name).
    Type,
    /// Identifier immediately followed by `(`.
    Function,
}

impl TokenKind {
    /// The theme colour for this class.
    #[must_use]
    pub const fn color(self, theme: &Theme) -> Color {
        match self {
            Self::Plain => theme.tokens.text,
            Self::Keyword => theme.tokens.syn_keyword,
            Self::String => theme.tokens.syn_string,
            Self::Number => theme.tokens.syn_number,
            Self::Comment => theme.tokens.syn_comment,
            Self::Type => theme.tokens.syn_type,
            Self::Function => theme.tokens.syn_function,
        }
    }
}

/// State that survives a line boundary. Forward-flowing only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScanState {
    /// Inside a `/* … */`-style block comment.
    in_block_comment: bool,
    /// Inside a triple-quoted / heredoc-ish string, with its delimiter.
    in_block_string: Option<[u8; 3]>,
}

impl ScanState {
    /// Whether the scanner is mid-construct, i.e. the next line's colours
    /// depend on this one.
    #[must_use]
    pub const fn is_continuing(self) -> bool {
        self.in_block_comment || self.in_block_string.is_some()
    }
}

/// One language's scanning rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Language {
    /// Canonical name.
    pub name: &'static str,
    /// Info-string aliases, lowercase.
    pub aliases: &'static [&'static str],
    /// Keywords.
    pub keywords: &'static [&'static str],
    /// Primitive/builtin type names.
    pub types: &'static [&'static str],
    /// Line-comment introducers.
    pub line_comment: &'static [&'static str],
    /// `(open, close)` block-comment markers.
    pub block_comment: Option<(&'static str, &'static str)>,
    /// Quote characters that open a string.
    pub quotes: &'static [char],
    /// Whether a triple quote opens a multi-line string.
    pub triple_quotes: bool,
}

const fn language(
    name: &'static str,
    aliases: &'static [&'static str],
    keywords: &'static [&'static str],
    types: &'static [&'static str],
) -> Language {
    Language {
        name,
        aliases,
        keywords,
        types,
        line_comment: &["//"],
        block_comment: Some(("/*", "*/")),
        quotes: &['"', '\'', '`'],
        triple_quotes: false,
    }
}

/// The bundled language table.
///
/// Chosen by what a coding agent actually emits into a fenced block, not by
/// coverage for its own sake. An unrecognised info string falls back to
/// [`Language::generic`], which still colours strings, numbers and comments —
/// the three that carry most of the readability win.
pub static LANGUAGES: &[Language] = &[
    language(
        "rust",
        &["rs"],
        &[
            "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
            "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
            "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super",
            "trait", "true", "type", "unsafe", "use", "where", "while",
        ],
        &[
            "bool", "char", "f32", "f64", "i128", "i16", "i32", "i64", "i8", "isize", "str",
            "String", "u128", "u16", "u32", "u64", "u8", "usize", "Vec", "Option", "Result",
        ],
    ),
    language(
        "typescript",
        &["ts", "tsx", "javascript", "js", "jsx", "mjs", "cjs"],
        &[
            "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
            "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally",
            "for", "from", "function", "if", "implements", "import", "in", "instanceof",
            "interface", "let", "new", "null", "of", "return", "satisfies", "static", "super",
            "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void",
            "while", "yield",
        ],
        &[
            "Array", "Promise", "Record", "any", "bigint", "boolean", "never", "number", "object",
            "string", "symbol", "unknown",
        ],
    ),
    Language {
        name: "python",
        aliases: &["py"],
        keywords: &[
            "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
            "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import",
            "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return",
            "True", "try", "while", "with", "yield",
        ],
        types: &["bool", "bytes", "dict", "float", "int", "list", "set", "str", "tuple"],
        line_comment: &["#"],
        block_comment: None,
        quotes: &['"', '\''],
        triple_quotes: true,
    },
    language(
        "go",
        &["golang"],
        &[
            "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
            "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range",
            "return", "select", "struct", "switch", "type", "var",
        ],
        &[
            "bool", "byte", "error", "float32", "float64", "int", "int32", "int64", "rune",
            "string", "uint", "uint8",
        ],
    ),
    Language {
        name: "bash",
        aliases: &["sh", "shell", "zsh", "console", "shell-session"],
        keywords: &[
            "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if",
            "in", "local", "return", "then", "until", "while",
        ],
        types: &["cd", "echo", "exit", "printf", "read", "set", "source", "test"],
        line_comment: &["#"],
        block_comment: None,
        quotes: &['"', '\''],
        triple_quotes: false,
    },
    Language {
        name: "json",
        aliases: &["jsonc", "json5"],
        keywords: &["false", "null", "true"],
        types: &[],
        line_comment: &["//"],
        block_comment: Some(("/*", "*/")),
        quotes: &['"'],
        triple_quotes: false,
    },
    Language {
        name: "toml",
        aliases: &["ini", "cfg"],
        keywords: &["false", "true"],
        types: &[],
        line_comment: &["#"],
        block_comment: None,
        quotes: &['"', '\''],
        triple_quotes: false,
    },
    Language {
        name: "yaml",
        aliases: &["yml"],
        keywords: &["false", "no", "null", "true", "yes"],
        types: &[],
        line_comment: &["#"],
        block_comment: None,
        quotes: &['"', '\''],
        triple_quotes: false,
    },
    Language {
        name: "sql",
        aliases: &["postgres", "psql", "sqlite"],
        keywords: &[
            "and", "as", "by", "create", "delete", "drop", "from", "group", "having", "insert",
            "into", "join", "left", "limit", "not", "null", "on", "or", "order", "select", "set",
            "table", "update", "values", "where", "with",
        ],
        types: &["boolean", "integer", "jsonb", "text", "timestamp", "uuid"],
        line_comment: &["--"],
        block_comment: Some(("/*", "*/")),
        quotes: &['"', '\''],
        triple_quotes: false,
    },
];

impl Language {
    /// The fallback: no keywords, but strings, numbers and `#`/`//` comments.
    #[must_use]
    pub const fn generic() -> Self {
        Self {
            name: "text",
            aliases: &[],
            keywords: &[],
            types: &[],
            line_comment: &["#", "//"],
            block_comment: Some(("/*", "*/")),
            quotes: &['"', '\'', '`'],
            triple_quotes: false,
        }
    }

    /// Resolve a fence info string (`rust`, `ts title=a.ts`, `Bash`).
    ///
    /// `None` for an empty info string, so a plain ``` ``` `` fence is rendered
    /// unhighlighted rather than guessed at.
    #[must_use]
    pub fn from_info(info: &str) -> Option<Self> {
        let token = info.split_whitespace().next()?;
        let token = token.split(',').next()?.trim().to_ascii_lowercase();
        if token.is_empty() {
            return None;
        }
        Some(
            LANGUAGES
                .iter()
                .find(|language| {
                    language.name == token || language.aliases.contains(&token.as_str())
                })
                .copied()
                .unwrap_or_else(Self::generic),
        )
    }
}

/// Highlight one line, returning its spans and the state for the next line.
///
/// `state` carries block comments and triple-quoted strings across lines.
#[must_use]
pub fn highlight_line(
    line: &str,
    language: Option<&Language>,
    state: ScanState,
    theme: &Theme,
) -> (Vec<Span>, ScanState) {
    let Some(language) = language else {
        return (
            vec![Span::new(line.to_owned(), theme.tokens.text.style())],
            state,
        );
    };
    let tokens = scan(line, language, state);
    let next = tokens.1;
    let spans = tokens
        .0
        .into_iter()
        .map(|(kind, text)| {
            let style = Style {
                fg: kind.color(theme).as_fg(),
                ..Style::default()
            };
            Span::new(text, style)
        })
        .collect();
    (spans, next)
}

/// The scanner. Returns `(kind, text)` runs covering the line exactly.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn scan(line: &str, language: &Language, mut state: ScanState) -> (Vec<(TokenKind, String)>, ScanState) {
    let mut out: Vec<(TokenKind, String)> = Vec::new();
    let bytes: Vec<char> = line.chars().collect();
    let mut index = 0usize;
    let push = |out: &mut Vec<(TokenKind, String)>, kind: TokenKind, text: String| {
        if text.is_empty() {
            return;
        }
        match out.last_mut() {
            Some((last_kind, last_text)) if *last_kind == kind => last_text.push_str(&text),
            _ => out.push((kind, text)),
        }
    };

    while index < bytes.len() {
        // Continuations first: they own the line until they close.
        if state.in_block_comment {
            let close = language.block_comment.map_or("*/", |(_, close)| close);
            let rest: String = bytes[index..].iter().collect();
            if let Some(at) = rest.find(close) {
                let end = index + rest[..at + close.len()].chars().count();
                push(&mut out, TokenKind::Comment, bytes[index..end].iter().collect());
                index = end;
                state.in_block_comment = false;
                continue;
            }
            push(&mut out, TokenKind::Comment, rest);
            break;
        }
        if let Some(delimiter) = state.in_block_string {
            let close: String = delimiter.iter().map(|byte| *byte as char).collect();
            let rest: String = bytes[index..].iter().collect();
            if let Some(at) = rest.find(&close) {
                let end = index + rest[..at + close.len()].chars().count();
                push(&mut out, TokenKind::String, bytes[index..end].iter().collect());
                index = end;
                state.in_block_string = None;
                continue;
            }
            push(&mut out, TokenKind::String, rest);
            break;
        }

        let rest: String = bytes[index..].iter().collect();

        // Line comments.
        if let Some(marker) = language
            .line_comment
            .iter()
            .find(|marker| rest.starts_with(**marker))
        {
            // `#!/usr/bin/env` is a comment; `#{` in a shell is not worth a
            // special case. Everything to end of line.
            let _ = marker;
            push(&mut out, TokenKind::Comment, rest);
            break;
        }
        // Block comments.
        if let Some((open, close)) = language.block_comment
            && let Some(body) = rest.strip_prefix(open)
        {
            if let Some(at) = body.find(close) {
                let end = index + rest[..open.len() + at + close.len()].chars().count();
                push(&mut out, TokenKind::Comment, bytes[index..end].iter().collect());
                index = end;
                continue;
            }
            push(&mut out, TokenKind::Comment, rest);
            state.in_block_comment = true;
            break;
        }

        let current = bytes[index];

        // Strings.
        if language.quotes.contains(&current) {
            if language.triple_quotes
                && bytes.get(index + 1) == Some(&current)
                && bytes.get(index + 2) == Some(&current)
            {
                let delimiter = [current as u8, current as u8, current as u8];
                let close: String = delimiter.iter().map(|byte| *byte as char).collect();
                let after: String = bytes[index + 3..].iter().collect();
                if let Some(at) = after.find(&close) {
                    let end = index + 3 + after[..at + 3].chars().count();
                    push(&mut out, TokenKind::String, bytes[index..end].iter().collect());
                    index = end;
                } else {
                    push(&mut out, TokenKind::String, rest);
                    state.in_block_string = Some(delimiter);
                    break;
                }
                continue;
            }
            let mut end = index + 1;
            let mut escaped = false;
            while end < bytes.len() {
                let ch = bytes[end];
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == current {
                    end += 1;
                    break;
                }
                end += 1;
            }
            push(&mut out, TokenKind::String, bytes[index..end.min(bytes.len())].iter().collect());
            index = end.min(bytes.len());
            continue;
        }

        // Numbers.
        if current.is_ascii_digit() && !preceded_by_word(&bytes, index) {
            let mut end = index;
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || bytes[end] == '.' || bytes[end] == '_')
            {
                end += 1;
            }
            push(&mut out, TokenKind::Number, bytes[index..end].iter().collect());
            index = end;
            continue;
        }

        // Words.
        if current.is_alphabetic() || current == '_' {
            let mut end = index;
            while end < bytes.len() && (bytes[end].is_alphanumeric() || bytes[end] == '_') {
                end += 1;
            }
            let word: String = bytes[index..end].iter().collect();
            let followed_by_call = bytes[end..]
                .iter()
                .find(|ch| !ch.is_whitespace())
                .is_some_and(|ch| *ch == '(');
            let kind = if language.keywords.contains(&word.as_str()) {
                TokenKind::Keyword
            } else if language.types.contains(&word.as_str()) {
                TokenKind::Type
            } else if followed_by_call {
                TokenKind::Function
            } else if word
                .chars()
                .next()
                .is_some_and(|ch| ch.is_uppercase())
                && word.chars().any(char::is_lowercase)
            {
                TokenKind::Type
            } else {
                TokenKind::Plain
            };
            push(&mut out, kind, word);
            index = end;
            continue;
        }

        push(&mut out, TokenKind::Plain, current.to_string());
        index += 1;
    }

    (out, state)
}

fn preceded_by_word(chars: &[char], index: usize) -> bool {
    index > 0 && (chars[index - 1].is_alphanumeric() || chars[index - 1] == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(line: &str, language: &Language) -> Vec<(TokenKind, String)> {
        scan(line, language, ScanState::default()).0
    }

    fn language(name: &str) -> Language {
        Language::from_info(name).unwrap()
    }

    #[test]
    fn info_strings_resolve_through_aliases_and_case() {
        assert_eq!(Language::from_info("rs").unwrap().name, "rust");
        assert_eq!(Language::from_info("TSX").unwrap().name, "typescript");
        assert_eq!(Language::from_info("py title=a.py").unwrap().name, "python");
        assert_eq!(Language::from_info("").map(|l| l.name), None);
    }

    #[test]
    fn an_unknown_language_still_colours_the_universal_three() {
        let generic = Language::from_info("brainfuck").unwrap();
        assert_eq!(generic.name, "text");
        let tokens = kinds("x = \"hi\" # note", &generic);
        assert!(tokens.iter().any(|(kind, _)| *kind == TokenKind::String));
        assert!(tokens.iter().any(|(kind, _)| *kind == TokenKind::Comment));
    }

    #[test]
    fn the_scan_covers_the_line_exactly() {
        for source in [
            "let x = 1;",
            "fn main() { /* hi */ }",
            "s = \"a\\\"b\" + 'c'",
            "  # comment only",
            "",
            "λ = 3.14_f64",
        ] {
            for name in ["rust", "python", "bash"] {
                let language = language(name);
                let rebuilt: String = kinds(source, &language)
                    .into_iter()
                    .map(|(_, text)| text)
                    .collect();
                assert_eq!(rebuilt, source, "{name}: {source:?}");
            }
        }
    }

    #[test]
    fn keywords_types_and_calls_get_distinct_classes() {
        let tokens = kinds("pub fn render(buffer: Vec) -> String {", &language("rust"));
        let find = |needle: &str| {
            tokens
                .iter()
                .find(|(_, text)| text == needle)
                .map(|(kind, _)| *kind)
        };
        assert_eq!(find("pub"), Some(TokenKind::Keyword));
        assert_eq!(find("render"), Some(TokenKind::Function));
        assert_eq!(find("Vec"), Some(TokenKind::Type));
        assert_eq!(find("String"), Some(TokenKind::Type));
    }

    #[test]
    fn a_number_inside_an_identifier_is_not_a_number() {
        let tokens = kinds("let sha256 = 256;", &language("rust"));
        assert_eq!(
            tokens
                .iter()
                .filter(|(kind, _)| *kind == TokenKind::Number)
                .count(),
            1
        );
    }

    #[test]
    fn escaped_quotes_do_not_end_a_string() {
        let tokens = kinds(r#"let s = "a\"b"; let t = 1;"#, &language("rust"));
        let string = tokens
            .iter()
            .find(|(kind, _)| *kind == TokenKind::String)
            .unwrap();
        assert_eq!(string.1, r#""a\"b""#);
    }

    #[test]
    fn an_unterminated_string_stops_at_the_line_end() {
        let (tokens, state) = scan("let s = \"open", &language("rust"), ScanState::default());
        assert_eq!(tokens.last().unwrap().0, TokenKind::String);
        assert!(!state.is_continuing(), "a single-quoted string does not span lines");
    }

    #[test]
    fn block_comments_carry_forward_and_only_forward() {
        let rust = language("rust");
        let (first, state) = scan("let a = 1; /* start", &rust, ScanState::default());
        assert!(state.in_block_comment);
        assert_eq!(first[0].0, TokenKind::Keyword);

        let (middle, state) = scan("still comment", &rust, state);
        assert_eq!(middle, vec![(TokenKind::Comment, "still comment".to_owned())]);
        assert!(state.in_block_comment);

        let (last, state) = scan("*/ let b = 2;", &rust, state);
        assert!(!state.in_block_comment);
        assert_eq!(last[0], (TokenKind::Comment, "*/".to_owned()));
        assert!(last.iter().any(|(kind, text)| *kind == TokenKind::Keyword && text == "let"));
    }

    #[test]
    fn triple_quoted_strings_span_lines_in_python_only() {
        let python = language("python");
        let (_, state) = scan("doc = \"\"\"start", &python, ScanState::default());
        assert!(state.in_block_string.is_some());
        let (middle, state) = scan("inside", &python, state);
        assert_eq!(middle[0].0, TokenKind::String);
        let (_, state) = scan("end\"\"\"", &python, state);
        assert!(!state.is_continuing());

        let rust = language("rust");
        let (_, state) = scan("let a = \"\"\"", &rust, ScanState::default());
        assert!(!state.is_continuing(), "rust has no triple quotes");
    }

    #[test]
    fn a_shell_comment_is_not_a_rust_comment_and_vice_versa() {
        assert_eq!(kinds("# hi", &language("bash"))[0].0, TokenKind::Comment);
        assert_ne!(kinds("# hi", &language("rust"))[0].0, TokenKind::Comment);
        assert_eq!(kinds("-- hi", &language("sql"))[0].0, TokenKind::Comment);
    }

    #[test]
    fn highlighting_maps_every_class_onto_a_theme_token() {
        let theme = Theme::lyra();
        let (spans, _) = highlight_line(
            "fn main() { let n = 1; /* c */ }",
            Some(&language("rust")),
            ScanState::default(),
            &theme,
        );
        let colors: Vec<_> = spans.iter().map(|span| span.style.fg).collect();
        assert!(colors.contains(&theme.tokens.syn_keyword.as_fg()));
        assert!(colors.contains(&theme.tokens.syn_number.as_fg()));
        assert!(colors.contains(&theme.tokens.syn_comment.as_fg()));
    }

    #[test]
    fn a_fence_with_no_language_is_left_alone() {
        let theme = Theme::lyra();
        let (spans, state) = highlight_line("anything at all", None, ScanState::default(), &theme);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "anything at all");
        assert!(!state.is_continuing());
    }
}
