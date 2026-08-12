import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha512Crypt } from '../src/core/sha512crypt';

// Vectores oficiales de la especificación de Ulrich Drepper (SHA-crypt.txt).
test('vector oficial: Hello world!', () => {
  assert.equal(
    sha512Crypt('Hello world!', 'saltstring'),
    '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1',
  );
});

test('vector oficial: rounds=10000', () => {
  assert.equal(
    sha512Crypt('Hello world!', 'saltstringsaltstring', 10000),
    '$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.',
  );
});

test('genera sal aleatoria válida cuando no se indica', () => {
  const hash = sha512Crypt('contraseña con ñ');
  assert.match(hash, /^\$6\$[./a-zA-Z0-9]{1,16}\$[./a-zA-Z0-9]{86}$/);
});
