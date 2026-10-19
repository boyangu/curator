import { describe, it, expect } from 'vitest';
import { parseTraxsourceRows } from '../src/index.js';

// Two rows in Traxsource's real search-page markup: an Original (empty version)
// and an Extended Mix (non-empty version), so we cover title/version split,
// the "key<br>bpm" cell, artists, label, genre, and duration.
const FIXTURE = `
<div id="searchTrackList" class="search-list-cont trk-list-cont v-">
  <div class="trklist v- full init-invis">
    <div data-trid="14430509" class="trk-row play-trk ptk-14430509">
      <div class="trk-cell tnum-pos">&nbsp;</div><div class="trk-cell thumb">
      <!--DIV thumb--><img src="x.jpg" /><div class="play-fly"><a href="#" class="com-play">p</a></div>
      </div><div class="trk-cell artit-cont"></div><div class="trk-cell title">
      <!--DIV title--><a href="/track/14430509/vibrant">Vibrant</a> <span class="adap-br"><br /></span><span class="version"> <span class="duration">(4:38)</span></span>
      </div><div class="trk-cell artists">
      <!--DIV artLinks--><a href="/artist/100710/hunter-game" class="com-artists" data-aid="100710">Hunter/Game</a>, <a href="/artist/352878/hollt" class="com-artists" data-aid="352878">Hollt</a>, <a href="/artist/571056/linn-stern" class="com-artists" data-aid="571056">Linn Stern</a> <span class="adap-br"><br /></span>
      </div><div class="trk-cell label">
      <!--DIV label--><a href="/label/30094/siamese">SIAMESE</a>
      </div><div class="trk-cell key-bpm">
        D#min<br>126
      </div><div class="trk-cell genre">
      <!--DIV genre-->Melodic / Progressive House
      </div>
    </div>
    <div data-trid="999" class="trk-row play-trk ptk-999">
      <div class="trk-cell tnum-pos">&nbsp;</div><div class="trk-cell title">
      <!--DIV title--><a href="/track/999/foo">Foo &amp; Bar</a> <span class="adap-br"><br /></span><span class="version"> Extended Mix <span class="duration">(6:30)</span></span>
      </div><div class="trk-cell artists">
      <a href="/artist/1/baz" class="com-artists" data-aid="1">Baz</a> <span class="adap-br"><br /></span>
      </div><div class="trk-cell label">
      <a href="/label/2/lbl">Some Label</a>
      </div><div class="trk-cell key-bpm">
        Amin<br>123
      </div><div class="trk-cell genre">
      Deep House
      </div>
    </div>
  </div>
</div>`;

describe('parseTraxsourceRows', () => {
	const rows = parseTraxsourceRows(FIXTURE);

	it('parses both rows', () => {
		expect(rows).toHaveLength(2);
	});

	it('extracts an Original (no version) with all fields', () => {
		expect(rows[0]).toMatchObject({
			id: 14430509,
			title: 'Vibrant',
			mix: null,
			duration: 278,
			bpm: 126,
			key: 'D#min',
			genre: 'Melodic / Progressive House',
			label: 'SIAMESE',
			artists: ['Hunter/Game', 'Hollt', 'Linn Stern'],
			isrc: null,
			release_date: null,
		});
		expect(rows[0]!.url).toBe('https://www.traxsource.com/track/14430509/vibrant');
	});

	it('extracts a versioned mix + decodes entities', () => {
		expect(rows[1]).toMatchObject({
			id: 999,
			title: 'Foo & Bar',
			mix: 'Extended Mix',
			duration: 390,
			bpm: 123,
			key: 'Amin',
			genre: 'Deep House',
			artists: ['Baz'],
		});
	});
});
