//! Tests for the streaming markdown renderer.
//!
//! The example-based tests below pin the *mapping* (what a heading looks like).
//! The property tests at the bottom pin the *invariant* — that streaming can
//! never contradict itself — which is the one thing no example can cover,
//! because it quantifies over every split point of every document.

use super::*;
use crate::theme::Theme;

fn theme() -> Theme {
    Theme::lyra()
}

fn texts(rows: &[Row]) -> Vec<String> {
    rows.iter().map(Row::plain_text).collect()
}

fn render(source: &str, width: u16) -> Vec<String> {
    texts(&render_document(source, &theme(), width))
}

/// Feed `source` to a stream in `chunk` byte-ish pieces, returning
/// `(committed rows, live rows at every step)`.
fn stream(source: &str, chunk: usize, width: u16) -> (Vec<Row>, usize) {
    let mut stream = MarkdownStream::new(theme(), width);
    let mut committed = Vec::new();
    let mut renders = 0usize;
    let mut start = 0usize;
    while start < source.len() {
        let mut end = (start + chunk).min(source.len());
        while !source.is_char_boundary(end) {
            end += 1;
        }
        let piece = &source[start..end];
        let rows = stream.push(piece);
        if piece.contains('\n') {
            renders += 1;
        }
        committed.extend(rows);
        start = end;
    }
    committed.extend(stream.finish());
    (committed, renders)
}

/// Split `source` at `points`, feed the pieces, and return everything the
/// stream ever committed plus its final live rows.
fn stream_at(source: &str, points: &[usize], width: u16) -> Vec<Row> {
    let mut stream = MarkdownStream::new(theme(), width);
    let mut out = Vec::new();
    let mut previous = 0usize;
    for point in points {
        let mut point = (*point).min(source.len());
        while !source.is_char_boundary(point) {
            point += 1;
        }
        if point <= previous {
            continue;
        }
        out.extend(stream.push(&source[previous..point]));
        previous = point;
    }
    if previous < source.len() {
        out.extend(stream.push(&source[previous..]));
    }
    out.extend(stream.finish());
    out
}

// ---------------------------------------------------------------------------
// Block mapping
// ---------------------------------------------------------------------------

#[test]
fn headings_are_strong_at_h1_and_modest_below() {
    let theme = theme();
    let rows = render_document("# One\n## Two\n### Three\n#### Four\n", &theme, 40);
    assert_eq!(texts(&rows), ["One", "Two", "Three", "Four"]);
    assert_eq!(rows[0].spans[0].style.fg, theme.tokens.heading.as_fg());
    assert_eq!(rows[1].spans[0].style.fg, theme.tokens.subheading.as_fg());
    assert_eq!(rows[2].spans[0].style.fg, theme.tokens.subheading.as_fg());
    assert!(rows[3].spans[0].style.modifiers.contains(Modifiers::BOLD));
    assert_ne!(rows[3].spans[0].style.fg, theme.tokens.heading.as_fg());
}

#[test]
fn a_hash_without_a_space_is_not_a_heading() {
    assert_eq!(render("#hashtag\n", 40), ["#hashtag"]);
    assert_eq!(render("####### seven\n", 40), ["####### seven"]);
}

#[test]
fn blockquotes_get_a_dim_rail() {
    let rows = render_document("> quoted\n", &theme(), 40);
    assert_eq!(rows[0].spans[0].text, format!("{QUOTE_RAIL} "));
    assert!(rows[0].plain_text().ends_with("quoted"));
}

#[test]
fn lists_cycle_bullets_by_depth_and_keep_ordered_numbers() {
    let rows = render("- one\n  - two\n    - three\n1. first\n2) second\n", 40);
    assert_eq!(
        rows,
        [
            "• one",
            "  ◦ two",
            "    ▪ three",
            "1. first",
            "2. second",
        ]
    );
}

#[test]
fn task_boxes_render_as_unicode_checkboxes() {
    assert_eq!(render("- [ ] todo\n- [x] done\n", 40), ["• ☐ todo", "• ☑ done"]);
}

#[test]
fn a_wrapped_list_item_hangs_under_its_text_not_its_bullet() {
    let rows = render("- alpha beta gamma delta epsilon\n", 16);
    assert_eq!(rows, ["• alpha beta", "  gamma delta", "  epsilon"]);
}

#[test]
fn rules_render_and_are_never_setext_headings() {
    // DESIGN deviation, deliberate: `---` under text is a rule, not an h2.
    let rows = render("text\n---\n", 40);
    assert_eq!(rows[0], "text");
    assert!(rows[1].starts_with('─'));
    // And `===` is literal, so no paragraph line is ever retro-restyled.
    assert_eq!(render("text\n===\n", 40), ["text", "==="]);
}

#[test]
fn consecutive_blank_lines_collapse_and_leading_ones_vanish() {
    assert_eq!(render("\n\n\na\n\n\n\nb\n", 40), ["a", "", "b"]);
}

#[test]
fn fenced_code_is_indented_and_highlighted() {
    let theme = theme();
    let rows = render_document("```rust\nfn main() {}\n```\n", &theme, 40);
    assert_eq!(texts(&rows), ["  fn main() {}"]);
    let keyword = rows[0]
        .spans
        .iter()
        .find(|span| span.text.trim() == "fn")
        .expect("a keyword span");
    assert_eq!(keyword.style.fg, theme.tokens.syn_keyword.as_fg());
}

#[test]
fn a_fence_with_no_language_is_rendered_but_not_coloured() {
    let theme = theme();
    let rows = render_document("```\nfn main() {}\n```\n", &theme, 40);
    assert_eq!(texts(&rows), ["  fn main() {}"]);
    assert!(rows[0]
        .spans
        .iter()
        .all(|span| span.style.fg == theme.tokens.text.as_fg()));
}

#[test]
fn a_tilde_fence_is_not_closed_by_backticks() {
    let rows = render("~~~\n```\nstill code\n~~~\n", 40);
    assert_eq!(rows, ["  ```", "  still code"]);
}

#[test]
fn indented_code_needs_a_preceding_blank_line() {
    // After a paragraph the indented line is a lazy continuation, not code.
    assert_eq!(render("para\n    not code\n", 40), ["para", "not code"]);
    assert_eq!(render("para\n\n    code\n", 40), ["para", "", "  code"]);
}

// ---------------------------------------------------------------------------
// Inline mapping
// ---------------------------------------------------------------------------

#[test]
fn emphasis_maps_onto_terminal_attributes() {
    let theme = theme();
    let spans = inline("**bold** *em* ~~gone~~", theme.text(), &theme);
    let modifiers = |needle: &str| {
        spans
            .iter()
            .find(|span| span.text == needle)
            .map(|span| span.style.modifiers)
    };
    assert_eq!(modifiers("bold"), Some(Modifiers::BOLD));
    assert_eq!(modifiers("em"), Some(Modifiers::ITALIC));
    assert_eq!(modifiers("gone"), Some(Modifiers::STRIKETHROUGH));
}

#[test]
fn nested_emphasis_composes_rather_than_replaces() {
    let theme = theme();
    let spans = inline("**bold and *both* here**", theme.text(), &theme);
    let both = spans.iter().find(|span| span.text == "both").unwrap();
    assert!(both.style.modifiers.contains(Modifiers::BOLD));
    assert!(both.style.modifiers.contains(Modifiers::ITALIC));
}

#[test]
fn code_spans_take_the_accent_and_stay_literal() {
    let theme = theme();
    let spans = inline("use `**not bold**` here", theme.text(), &theme);
    let code = spans
        .iter()
        .find(|span| span.style.fg == theme.tokens.accent.as_fg())
        .unwrap();
    assert_eq!(code.text, "**not bold**");
}

#[test]
fn an_unclosed_marker_renders_literally() {
    let theme = theme();
    for source in ["**open", "`open", "[label](", "~~open"] {
        let text: String = inline(source, theme.text(), &theme)
            .iter()
            .map(|span| span.text.as_str())
            .collect();
        assert_eq!(text, source, "{source:?}");
    }
}

#[test]
fn links_become_osc8_spans_and_can_be_turned_off() {
    let theme = theme();
    let spans = inline("see [docs](https://example.com/x) now", theme.text(), &theme);
    let link = spans.iter().find(|span| span.text == "docs").unwrap();
    assert_eq!(link.link.as_deref(), Some("https://example.com/x"));
    assert!(link.style.modifiers.contains(Modifiers::UNDERLINE));

    let mut plain = theme.clone();
    plain.hyperlinks = false;
    let spans = inline("see [docs](https://example.com/x)", plain.text(), &plain);
    assert!(spans.iter().all(|span| span.link.is_none()));
}

#[test]
fn bare_urls_and_autolinks_are_linked_too() {
    let theme = theme();
    let spans = inline("go to https://example.com. now", theme.text(), &theme);
    let link = spans.iter().find(|span| span.link.is_some()).unwrap();
    assert_eq!(link.text, "https://example.com", "trailing period is prose");

    let spans = inline("<https://example.com/a>", theme.text(), &theme);
    assert_eq!(
        spans.iter().find(|span| span.link.is_some()).unwrap().text,
        "https://example.com/a"
    );
}

#[test]
fn an_osc8_span_survives_the_scrollback_path() {
    let theme = theme();
    let rows = render_document("[docs](https://example.com)\n", &theme, 40);
    let mut out = Vec::new();
    rows[0].write_ansi(40, &mut out);
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("\x1b]8;;https://example.com\x1b\\"), "{text:?}");
    assert!(text.ends_with("\x1b[0m"));
    assert_eq!(text.matches("\x1b]8;;").count(), 2, "the link is closed");
}

#[test]
fn backslash_escapes_defuse_markers() {
    let theme = theme();
    let text: String = inline(r"\*not em\*", theme.text(), &theme)
        .iter()
        .map(|span| span.text.as_str())
        .collect();
    assert_eq!(text, "*not em*");
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

#[test]
fn a_table_solves_column_widths_and_underlines_its_header() {
    let rows = render("| name | kind |\n|---|---|\n| alpha | fast |\n| b | slow |\n", 40);
    assert_eq!(rows[0], "name   kind");
    assert!(rows[1].starts_with('─') && rows[1].contains("  ─"));
    assert_eq!(rows[2], "alpha  fast");
    assert_eq!(rows[3], "b      slow");
}

#[test]
fn table_alignment_comes_from_the_delimiter_row() {
    let rows = render("| a | b | c |\n|:---|:--:|---:|\n| 1 | 2 | 3 |\n", 40);
    assert_eq!(rows[2], "1  2  3");
    let rows = render("| left | mid | right |\n|:---|:--:|---:|\n| x | y | z |\n", 40);
    assert_eq!(rows[2], "x      y       z");
}

#[test]
fn an_over_wide_column_truncates_with_a_visible_ellipsis() {
    let source = "| name | note |\n|---|---|\n| a | this note is far too long to fit |\n";
    let rows = render(source, 24);
    assert!(rows.iter().any(|row| row.contains('…')), "{rows:?}");
    for row in &rows {
        assert!(row.width() <= 24, "{row:?}");
    }
}

#[test]
fn a_table_too_narrow_to_solve_degrades_to_key_value() {
    let source = "| name | kind | note |\n|---|---|---|\n| a | b | c |\n| d | e | f |\n";
    let rows = render(source, 14);
    assert_eq!(
        rows,
        ["name: a", "kind: b", "note: c", "", "name: d", "kind: e", "note: f"]
    );
}

#[test]
fn a_line_with_pipes_that_is_not_a_table_stays_a_paragraph() {
    assert_eq!(render("a | b\nnot a delimiter\n", 40), ["a | b", "not a delimiter"]);
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

#[test]
fn no_rendered_row_ever_exceeds_the_width() {
    let source = "# A heading that is definitely longer than the terminal\n\
                  > a quoted passage that also runs long enough to wrap twice over\n\
                  - a list item with supercalifragilisticexpialidocious inside it\n\
                  ```rust\nlet x = \"a very long string literal that will not fit\";\n```\n\
                  | a | b |\n|---|---|\n| long cell value here | another long value |\n";
    for width in [8u16, 12, 20, 40, 80] {
        for row in render_document(source, &theme(), width) {
            assert!(
                row.width() <= usize::from(width),
                "width {width}: {:?} is {} columns",
                row.plain_text(),
                row.width()
            );
        }
    }
}

#[test]
fn wrapping_preserves_styling_across_the_break() {
    let theme = theme();
    let rows = render_document("**alpha beta gamma delta**\n", &theme, 12);
    assert!(rows.len() > 1);
    for row in &rows {
        for span in &row.spans {
            if span.text.trim().is_empty() {
                continue;
            }
            assert!(
                span.style.modifiers.contains(Modifiers::BOLD),
                "bold was lost at a wrap: {:?}",
                span.text
            );
        }
    }
}

#[test]
fn wide_graphemes_are_measured_in_columns() {
    for row in render_document("あいうえおかきくけこさしすせそ\n", &theme(), 8) {
        assert!(row.width() <= 8, "{:?}", row.plain_text());
    }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

#[test]
fn publishing_happens_at_line_boundaries_not_at_token_boundaries() {
    let mut stream = MarkdownStream::new(theme(), 40);
    for token in ["a ", "few ", "tokens ", "with ", "no ", "newline"] {
        assert!(
            stream.push(token).is_empty(),
            "a token without a newline must publish nothing"
        );
    }
    assert!(!stream.push(" done\nnext line\n").is_empty());
}

#[test]
fn the_live_region_shows_the_unstable_tail() {
    let mut stream = MarkdownStream::new(theme(), 40);
    let _ = stream.push("committed line\n");
    let _ = stream.push("still stream");
    assert_eq!(texts(&stream.live_rows()), ["still stream"]);
}

#[test]
fn a_paragraph_that_becomes_a_table_is_never_committed_as_a_paragraph() {
    let mut stream = MarkdownStream::new(theme(), 40);
    let committed = stream.push("| name | kind |\n");
    assert!(
        committed.is_empty(),
        "a line with pipes must wait for the next line: {:?}",
        texts(&committed)
    );
    let committed = stream.push("|---|---|\n");
    assert!(committed.is_empty(), "an open table is not stable");
    let committed = stream.push("| a | b |\n");
    assert!(committed.is_empty(), "column widths still depend on later rows");
    let mut all = committed;
    all.extend(stream.push("\ndone\n"));
    all.extend(stream.finish());
    assert_eq!(
        texts(&all),
        render("| name | kind |\n|---|---|\n| a | b |\n\ndone\n", 40)
    );
}

#[test]
fn code_lines_commit_as_they_arrive_rather_than_waiting_for_the_fence() {
    let mut stream = MarkdownStream::new(theme(), 40);
    let _ = stream.push("```rust\n");
    let committed = stream.push("let a = 1;\n");
    assert_eq!(
        texts(&committed),
        ["  let a = 1;"],
        "a 400-line code block must stream, not buffer"
    );
}

#[test]
fn a_block_comment_opened_in_one_delta_colours_the_next() {
    let theme = theme();
    let mut stream = MarkdownStream::new(theme.clone(), 40);
    let _ = stream.push("```rust\nlet a = 1; /* open\n");
    let committed = stream.push("still comment\n");
    assert_eq!(
        committed[0].spans[1].style.fg,
        theme.tokens.syn_comment.as_fg(),
        "scanner state must survive the stable boundary"
    );
}

#[test]
fn a_stream_reproduces_the_one_shot_render_for_the_designs_worst_case() {
    let source = "# Title\n\nIntro paragraph with `code` and **bold**.\n\n\
                  | name | kind | note |\n|---|:--:|---:|\n\
                  | alpha | fast | short |\n| beta | slow | a longer note |\n\n\
                  > quoted\n\n```rust\nfn main() {\n    println!(\"hi\");\n}\n```\n\n\
                  - one\n- two\n\ntrailing text | with a pipe\n";
    for chunk in [1usize, 3, 7, 40, 4096] {
        let (committed, _) = stream(source, chunk, 40);
        assert_eq!(
            texts(&committed),
            render(source, 40),
            "chunk size {chunk} diverged from the one-shot render"
        );
    }
}

#[test]
fn committed_rows_are_dropped_from_the_pending_buffer() {
    let mut stream = MarkdownStream::new(theme(), 40);
    for index in 0..200 {
        let _ = stream.push(&format!("line {index}\n"));
    }
    assert!(
        stream.is_empty(),
        "a long turn must cost its unstable tail, not its transcript"
    );
    assert_eq!(stream.committed_rows(), 200);
}

#[test]
fn a_width_change_reflows_only_the_unstable_tail() {
    let mut stream = MarkdownStream::new(theme(), 12);
    let committed = stream.push("alpha beta gamma\n");
    assert_eq!(
        texts(&committed),
        ["alpha beta", "gamma"],
        "wrapped at the old width"
    );
    stream.set_width(40);
    let later = stream.push("delta epsilon zeta eta\n");
    assert_eq!(
        texts(&later),
        ["delta epsilon zeta eta"],
        "only what arrives after the resize uses the new width"
    );
}

// ---------------------------------------------------------------------------
// The monotonicity property (DESIGN.md §1)
// ---------------------------------------------------------------------------

/// Corpus of documents built from the constructs that *can* retro-edit.
fn corpus() -> Vec<String> {
    vec![
        "| a | b |\n|---|---|\n| 1 | 2 |\n".to_owned(),
        "text\n| a | b |\n|---|---|\n| 1 | 2 |\nafter\n".to_owned(),
        "a | b\n---\nc\n".to_owned(),
        "para\n===\n".to_owned(),
        "```rust\nfn a() {}\n```\ntail\n".to_owned(),
        "```\n| a | b |\n|---|---|\n```\n".to_owned(),
        "# h\n\n> q\n\n- l\n\n    code\n\ntail | pipe\n".to_owned(),
        "no newline at the end".to_owned(),
        "|\n|\n|---|\n".to_owned(),
        "\n\n\n".to_owned(),
        String::new(),
    ]
}

#[test]
fn every_split_of_every_corpus_document_reproduces_the_one_shot_render() {
    for source in corpus() {
        let expected = render(&source, 24);
        for split in 0..=source.len() {
            if !source.is_char_boundary(split) {
                continue;
            }
            let actual = texts(&stream_at(&source, &[split], 24));
            assert_eq!(actual, expected, "{source:?} split at {split}");
        }
    }
}

#[test]
fn the_committed_prefix_is_never_taken_back() {
    for source in corpus() {
        let expected = render(&source, 24);
        let mut stream = MarkdownStream::new(theme(), 24);
        let mut committed: Vec<String> = Vec::new();
        let mut start = 0usize;
        while start < source.len() {
            let mut end = (start + 2).min(source.len());
            while !source.is_char_boundary(end) {
                end += 1;
            }
            committed.extend(texts(&stream.push(&source[start..end])));
            assert_eq!(
                committed[..],
                expected[..committed.len()],
                "{source:?}: a committed row contradicted the final render"
            );
            start = end;
        }
        committed.extend(texts(&stream.finish()));
        assert_eq!(committed, expected, "{source:?}");
    }
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(256))]

    /// The load-bearing property, stated exactly as DESIGN.md §1 requires: for
    /// random split points of random markdown, the rows the stream commits must
    /// byte-equal the same region rendered from the complete document.
    #[test]
    fn streaming_any_document_at_any_split_points_matches_the_one_shot_render(
        source in markdown_document(),
        splits in proptest::collection::vec(0usize..400, 0..12),
        width in 8u16..64,
    ) {
        let expected = texts(&render_document(&source, &theme(), width));
        let mut points: Vec<usize> = splits;
        points.sort_unstable();
        let actual = texts(&stream_at(&source, &points, width));
        proptest::prop_assert_eq!(actual, expected);
    }

    /// The weaker but sharper statement: at *every* intermediate step the rows
    /// committed so far are a prefix of the final render. A violation here is a
    /// row the terminal is showing that the finished document contradicts —
    /// and there is no way to take it back.
    #[test]
    fn the_committed_prefix_is_monotone_at_every_step(
        source in markdown_document(),
        chunk in 1usize..17,
        width in 8u16..64,
    ) {
        let expected = texts(&render_document(&source, &theme(), width));
        let mut stream = MarkdownStream::new(theme(), width);
        let mut committed: Vec<String> = Vec::new();
        let mut start = 0usize;
        while start < source.len() {
            let mut end = (start + chunk).min(source.len());
            while !source.is_char_boundary(end) {
                end += 1;
            }
            committed.extend(texts(&stream.push(&source[start..end])));
            proptest::prop_assert!(
                committed.len() <= expected.len(),
                "committed {} rows, document renders {}",
                committed.len(),
                expected.len()
            );
            proptest::prop_assert_eq!(&committed[..], &expected[..committed.len()]);
            start = end;
        }
        committed.extend(texts(&stream.finish()));
        proptest::prop_assert_eq!(committed, expected);
    }

    /// Whatever the input, no row may exceed the terminal width: a row that
    /// does is wrapped by the *terminal*, which the compositor did not predict,
    /// which desynchronises its row accounting.
    #[test]
    fn no_row_ever_exceeds_the_width(source in markdown_document(), width in 4u16..40) {
        for row in render_document(&source, &theme(), width) {
            proptest::prop_assert!(
                row.width() <= usize::from(width),
                "{:?} is {} columns at width {}",
                row.plain_text(),
                row.width(),
                width
            );
        }
    }
}

/// Random markdown built from the constructs that interact badly, rather than
/// from arbitrary text: uniform random bytes would almost never produce a
/// delimiter row, and the delimiter row is the whole problem.
fn markdown_document() -> impl proptest::strategy::Strategy<Value = String> {
    use proptest::prelude::*;

    let line = prop_oneof![
        Just(String::new()),
        Just("# heading".to_owned()),
        Just("## sub".to_owned()),
        Just("text with **bold** and `code`".to_owned()),
        Just("a | b".to_owned()),
        Just("| name | kind |".to_owned()),
        Just("|---|---|".to_owned()),
        Just("|:--|--:|".to_owned()),
        Just("| alpha | a much longer cell |".to_owned()),
        Just("---".to_owned()),
        Just("===".to_owned()),
        Just("> quote".to_owned()),
        Just("- item".to_owned()),
        Just("  - nested".to_owned()),
        Just("1. ordered".to_owned()),
        Just("```rust".to_owned()),
        Just("```".to_owned()),
        Just("~~~".to_owned()),
        Just("fn main() { /* open".to_owned()),
        Just("*/ }".to_owned()),
        Just("    indented".to_owned()),
        Just("[link](https://example.com)".to_owned()),
        Just("あいう wide text".to_owned()),
        Just("supercalifragilisticexpialidocious".to_owned()),
    ];
    (proptest::collection::vec(line, 0..14), any::<bool>()).prop_map(
        |(lines, trailing_newline)| {
            let mut source = lines.join("\n");
            if trailing_newline && !source.is_empty() {
                source.push('\n');
            }
            source
        },
    )
}
