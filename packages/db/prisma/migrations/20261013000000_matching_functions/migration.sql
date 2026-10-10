-- Eşleştirme yardımcıları (spec §5.2). IMMUTABLE: indeks ve planlayıcı dostu.
CREATE OR REPLACE FUNCTION confidence_rank(c text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE c WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END
$$;

-- Türkçe harfleri ASCII'ye katlar, sonra küçültür: locale'den bağımsız karşılaştırma.
CREATE OR REPLACE FUNCTION fold_tr(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(translate(t, 'İIıĞğÜüŞşÖöÇç', 'iiigguussoocc'))
$$;
