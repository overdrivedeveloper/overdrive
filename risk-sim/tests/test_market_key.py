from risk_sim.book import market_key


def test_market_id_decodes_to_the_symbol_and_other_keys_pass_through():
    eth = "0x" + "ETH".encode().hex().ljust(64, "0")
    assert market_key(eth) == "ETH"
    assert market_key("ETH") == "ETH"
    assert market_key("0x" + "ab" * 32) == "0x" + "ab" * 32  # not ASCII: a pair hash or a gear id stays as is
