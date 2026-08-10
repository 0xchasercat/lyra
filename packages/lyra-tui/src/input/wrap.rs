//! Composer line wrapping.
//!
//! The composer wraps a sequence of **atoms**, not a string: a paste chip is one
//! atom and a wide CJK glyph is one atom, and both need break rules that a
//! whitespace-splitting wrapper does not have.
//!
//! # Break opportunities
//!
//! A line may break before atom `i` when any of these holds:
//!
//! - atom `i - 1` is a space (the ordinary Latin rule);
//! - atom `i - 1` is **wide**, or atom `i` is **wide**. CJK text contains no
//!   spaces, so without this rule a paragraph of Japanese is one unbreakable
//!   token that overflows every line. Breaking between any two wide glyphs is
//!   the standard approximation and is why CJK stays column-aligned here;
//! - either side is a chip. A chip is a token of its own and never merges with
//!   the text around it.
//!
//! When no opportunity exists inside the line — a 200-character URL, a single
//! enormous identifier — the wrap is *hard*, at the column. Overflowing would
//! break DESIGN.md §3's "the page never scrolls horizontally".

use std::ops::Range;

/// What an atom is, for wrapping purposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PieceKind {
    /// A hard line break. Zero width, ends its line, belongs to it.
    Newline,
    /// A space or other break-after whitespace.
    Space,
    /// An ordinary narrow grapheme.
    Narrow,
    /// A wide (typically CJK) grapheme: a break opportunity on both sides.
    Wide,
    /// A paste chip: an unbreakable token with break opportunities on both
    /// sides.
    Chip,
}

/// One atom, reduced to what wrapping needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Piece {
    /// Display columns.
    pub width: usize,
    /// Break behaviour.
    pub kind: PieceKind,
}

impl Piece {
    /// A piece.
    #[must_use]
    pub const fn new(width: usize, kind: PieceKind) -> Self {
        Self { width, kind }
    }
}

/// Wrap `pieces` into lines of at most `width` columns.
///
/// Returns half-open ranges over `pieces`. There is always at least one line,
/// and the ranges tile `0..pieces.len()` exactly — every atom is on exactly one
/// line, which is what makes caret mapping a lookup rather than a search.
#[must_use]
pub fn wrap(pieces: &[Piece], width: usize) -> Vec<Range<usize>> {
    let width = width.max(1);
    let mut lines: Vec<Range<usize>> = Vec::new();
    let mut start = 0usize;
    let mut used = 0usize;
    let mut opportunity: Option<usize> = None;

    let mut index = 0usize;
    while index < pieces.len() {
        let piece = pieces[index];
        if piece.kind == PieceKind::Newline {
            lines.push(start..index + 1);
            start = index + 1;
            used = 0;
            opportunity = None;
            index += 1;
            continue;
        }
        if index > start && breaks_before(pieces, index) {
            opportunity = Some(index);
        }
        if used > 0 && used + piece.width > width {
            let at = opportunity.filter(|at| *at > start).unwrap_or(index);
            lines.push(start..at);
            start = at;
            used = pieces[start..index].iter().map(|piece| piece.width).sum();
            opportunity = None;
            for candidate in start + 1..=index {
                if breaks_before(pieces, candidate) {
                    opportunity = Some(candidate);
                }
            }
        }
        used += piece.width;
        index += 1;
    }
    lines.push(start..pieces.len());
    lines
}

/// Whether a line may break immediately before `index`.
fn breaks_before(pieces: &[Piece], index: usize) -> bool {
    let Some(previous) = index.checked_sub(1).and_then(|at| pieces.get(at)) else {
        return false;
    };
    let current = pieces[index];
    matches!(previous.kind, PieceKind::Space | PieceKind::Wide | PieceKind::Chip)
        || matches!(current.kind, PieceKind::Wide | PieceKind::Chip)
}

/// Locate an atom index in a wrapped layout.
///
/// Returns `(line, column)` where `column` is the display column the caret sits
/// at. An index equal to `pieces.len()` lands at the end of the last line, which
/// is where the caret is when the buffer ends.
#[must_use]
pub fn locate(pieces: &[Piece], lines: &[Range<usize>], index: usize) -> (usize, usize) {
    for (row, line) in lines.iter().enumerate() {
        // The caret belongs to the *last* line that contains the index, except
        // that an index at a line's end also opens the next line; preferring the
        // earlier line keeps the caret visible after a wrap rather than parking
        // it in column 0 of a line that has not been typed yet.
        if index < line.end || (index == line.end && row + 1 == lines.len()) {
            let column = pieces[line.start..index.min(line.end)]
                .iter()
                .filter(|piece| piece.kind != PieceKind::Newline)
                .map(|piece| piece.width)
                .sum();
            return (row, column);
        }
    }
    (lines.len().saturating_sub(1), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn narrow(count: usize) -> Vec<Piece> {
        vec![Piece::new(1, PieceKind::Narrow); count]
    }

    /// Build pieces from a sketch string: `_` is a space, `#` a wide glyph,
    /// `@` a chip four columns wide, `/` a newline, anything else narrow.
    fn sketch(text: &str) -> Vec<Piece> {
        text.chars()
            .map(|c| match c {
                '_' => Piece::new(1, PieceKind::Space),
                '#' => Piece::new(2, PieceKind::Wide),
                '@' => Piece::new(4, PieceKind::Chip),
                '/' => Piece::new(0, PieceKind::Newline),
                _ => Piece::new(1, PieceKind::Narrow),
            })
            .collect()
    }

    fn widths(pieces: &[Piece], lines: &[Range<usize>]) -> Vec<usize> {
        lines
            .iter()
            .map(|line| pieces[line.clone()].iter().map(|piece| piece.width).sum())
            .collect()
    }

    #[test]
    fn an_empty_buffer_still_has_one_line() {
        assert_eq!(wrap(&[], 20), vec![0..0]);
    }

    #[test]
    fn text_that_fits_is_one_line() {
        let pieces = narrow(10);
        assert_eq!(wrap(&pieces, 20), vec![0..10]);
    }

    #[test]
    fn the_lines_tile_the_input_exactly() {
        let pieces = sketch("hello_world_this_is_a_test_of_wrapping");
        let lines = wrap(&pieces, 11);
        assert_eq!(lines.first().unwrap().start, 0);
        assert_eq!(lines.last().unwrap().end, pieces.len());
        for pair in lines.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "{lines:?}");
        }
    }

    #[test]
    fn wrapping_prefers_a_space_boundary() {
        let pieces = sketch("alpha_beta_gamma");
        let lines = wrap(&pieces, 11);
        // "alpha_beta_" then "gamma": the break lands after a space, so no word
        // is split.
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], 0..11);
    }

    #[test]
    fn a_token_longer_than_the_width_hard_wraps_rather_than_overflowing() {
        let pieces = narrow(25);
        let lines = wrap(&pieces, 10);
        assert_eq!(lines, [0..10, 10..20, 20..25]);
        assert!(widths(&pieces, &lines).iter().all(|width| *width <= 10));
    }

    #[test]
    fn cjk_breaks_between_glyphs_and_stays_column_aligned() {
        let pieces = sketch("##########");
        let lines = wrap(&pieces, 9);
        // Four wide glyphs is 8 columns; a fifth would be 10.
        assert_eq!(widths(&pieces, &lines), [8, 8, 4]);
    }

    #[test]
    fn a_wide_glyph_never_straddles_the_column() {
        let pieces = sketch("ab#");
        let lines = wrap(&pieces, 3);
        assert_eq!(lines, [0..2, 2..3], "the wide glyph moves down whole");
        assert!(widths(&pieces, &lines).iter().all(|width| *width <= 3));
    }

    #[test]
    fn a_chip_is_an_unbreakable_token_with_air_on_both_sides() {
        let pieces = sketch("abc_@_def");
        let lines = wrap(&pieces, 6);
        // "abc_" then the chip, which is four columns wide on its own line.
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert_eq!(pieces[lines[1].clone()][0].kind, PieceKind::Chip);
    }

    #[test]
    fn a_newline_ends_its_line_and_belongs_to_it() {
        let pieces = sketch("ab/cd");
        assert_eq!(wrap(&pieces, 20), [0..3, 3..5]);
    }

    #[test]
    fn a_trailing_newline_opens_an_empty_final_line_for_the_caret() {
        let pieces = sketch("ab/");
        let lines = wrap(&pieces, 20);
        assert_eq!(lines, [0..3, 3..3]);
        assert_eq!(locate(&pieces, &lines, 3), (1, 0));
    }

    #[test]
    fn locate_finds_the_caret_column_in_display_units() {
        let pieces = sketch("##ab");
        let lines = wrap(&pieces, 20);
        assert_eq!(locate(&pieces, &lines, 0), (0, 0));
        assert_eq!(locate(&pieces, &lines, 1), (0, 2));
        assert_eq!(locate(&pieces, &lines, 2), (0, 4));
        assert_eq!(locate(&pieces, &lines, 4), (0, 6));
    }

    #[test]
    fn locate_keeps_the_caret_on_the_line_it_just_filled() {
        let pieces = narrow(20);
        let lines = wrap(&pieces, 10);
        assert_eq!(lines, [0..10, 10..20]);
        assert_eq!(
            locate(&pieces, &lines, 10),
            (1, 0),
            "index 10 opens the second line"
        );
        assert_eq!(locate(&pieces, &lines, 20), (1, 10));
    }

    #[test]
    fn a_zero_width_terminal_does_not_divide_by_zero() {
        let pieces = narrow(3);
        assert_eq!(wrap(&pieces, 0).len(), 3);
    }
}
