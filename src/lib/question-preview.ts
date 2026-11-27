export interface ChallengeQuestionPreview {
  description: string;
  examples: readonly string[];
}

const PREVIEWS: Record<'mudah' | 'sedang' | 'sulit', ChallengeQuestionPreview> = {
  mudah: {
    description: 'Satu operasi dengan angka sederhana.',
    examples: ['12 + 1 = ?', '24 − 3 = ?', '7 × 8 = ?'],
  },
  sedang: {
    description: 'Dua operasi dalam satu hitungan.',
    examples: ['80 + 35 − 10 = ?', '12 × 8 + 15 = ?', '93 ÷ 3 + 25 = ?'],
  },
  sulit: {
    description: 'Tiga atau lebih operasi dalam satu hitungan.',
    examples: ['25 × 12 + 20 − 5 = ?', '(20 + 15) × 3 − 10 = ?', '60 ÷ 3 + 30 × 2 = ?'],
  },
};

export function getChallengeQuestionPreview(difficulty: string): ChallengeQuestionPreview {
  return PREVIEWS[difficulty as keyof typeof PREVIEWS] ?? PREVIEWS.sedang;
}
