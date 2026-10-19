// Shared key chip for the Solid render sites (player, small player,
// discover). Mirrors keyChipHtml() in music-utils for the vanilla innerHTML
// sites — same .key-chip class, same colour, same format preference. Reads
// resolveKeyChip() in the render body so it re-renders reactively when the
// user flips keyDisplayFormat in Settings.
import { resolveKeyChip } from '../music-utils.js';

export function KeyChip(props: { keyCamelot: string | null | undefined }) {
	const chip = () => resolveKeyChip(props.keyCamelot);
	return (
		<span
			class="key-chip"
			classList={{
				'key-chip--A': chip()?.mode === 'A',
				'key-chip--B': chip()?.mode === 'B',
				'key-chip--empty': !chip(),
			}}
			style={chip() ? { '--key-h': String(chip()!.hue) } : undefined}
		>
			{chip()?.label ?? '—'}
		</span>
	);
}
