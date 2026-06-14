use std::path::Path;

fn fixture(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
        .to_string_lossy()
        .to_string()
}

#[test]
fn test_real_mame_logiqx_dat() {
    let path = fixture("mame_2000_xml.dat");
    let (games, stats) = rom_manager::dat::parse_dat(&path).unwrap();

    assert!(stats.total_games > 0, "should parse games from real MAME DAT");
    assert!(stats.total_roms > 0, "should parse ROMs from real MAME DAT");
    assert!(stats.errors.is_empty(), "no parse errors: {:?}", stats.errors);

    let names: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
    assert!(names.contains(&"1942"), "1942 should be in MAME 2000");
    assert!(names.contains(&"1943"), "1943 should be in MAME 2000");
    assert!(names.contains(&"720"), "720 should be in MAME 2000");

    let first = &games[0];
    assert!(!first.description.is_empty(), "game should have description");
}

#[test]
fn test_real_fbneo_clrmamepro_dat() {
    let path = fixture("fbneo_arcade_games.dat");
    let (games, stats) = rom_manager::dat::parse_dat(&path).unwrap();

    assert!(stats.total_games > 0, "should parse games from real FBNeo DAT");
    assert!(stats.total_roms > 0, "should parse ROMs from real FBNeo DAT");
    assert!(stats.errors.is_empty(), "no parse errors: {:?}", stats.errors);

    let names: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
    assert!(names.contains(&"'88 Games"));
    assert!(names.contains(&"1942 (C64 Music)"));

    let first = &games[0];
    assert_eq!(first.name, "'88 Games");
}
