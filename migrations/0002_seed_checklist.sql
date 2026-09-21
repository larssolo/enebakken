-- Punkterne som de står på siden i dag, så databasen starter med det
-- indhold ejeren allerede kender. Kan køres igen uden at lave dubletter:
-- (list, position) er unik, og konflikter springes over.

begin;

insert into checklist_items (list, label, position) values
    ('luk',   'Luk for gassen til køleskabet',                                  1),
    ('luk',   'Tøm køleskabet og lad det stå åbent',                            2),
    ('luk',   'Tøm wc',                                                         3),
    ('luk',   'Sluk for strømmen til wc-blæseren',                              4),
    ('luk',   'Tøm vand af dunke og indendørs tanke',                           5),
    ('luk',   'Støvsug hovedhuset',                                             6),
    ('luk',   'Støvsug annexet',                                                7),
    ('luk',   'Lås huset',                                                      8),
    ('luk',   'Lås værksted',                                                   9),
    ('luk',   'Lås anneks',                                                    10),
    ('luk',   'Luk lågen',                                                     11),
    ('luk',   'Fyld brændekurve',                                              12),
    ('luk',   'Fortæl ved lejlighed hvad der er taget af husets madlager',     13),
    ('aaben', 'Åbn for gassen til køleskabet og tænd det',                      1),
    ('aaben', 'Tænd for strømmen til wc-blæseren',                              2),
    ('aaben', 'Gør wc klart til brug',                                          3),
    ('aaben', 'Fyld vand på dunke og tanke',                                    4)
on conflict (list, position) do nothing;

commit;
