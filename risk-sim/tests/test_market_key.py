from risk_sim.book import market_key


def test_market_id_decodes_to_the_symbol_and_other_keys_pass_through():
    eth = "0x" + "ETH".encode().hex().ljust(64, "0")
    assert market_key(eth) == "ETH"
    assert market_key("ETH") == "ETH"
    assert market_key("0x" + "ab" * 32) == "0x" + "ab" * 32  # not ASCII: a pair hash or a gear id stays as is


ETH = "0x" + "ETH".encode().hex().ljust(64, "0")
BTC = "0x" + "BTC".encode().hex().ljust(64, "0")
ETH_OVER_BTC_MARKET = "0x53a0b92e86a2442720353fd0555f985c34c582969c5f45ba30cf5194eaff582d"  # not-a-key: cast keccak $(cast abi-encode "f(bytes32,bytes32)" ETH BTC)


def test_pair_market_key_matches_the_oracle_pair_key_vector():
    from risk_sim.book import pair_market_key

    assert pair_market_key(ETH, BTC) == ETH_OVER_BTC_MARKET
    assert pair_market_key(ETH.upper().replace("0X", "0x"), BTC) == ETH_OVER_BTC_MARKET
    assert pair_market_key(BTC, ETH) != ETH_OVER_BTC_MARKET      # A over B: order matters
